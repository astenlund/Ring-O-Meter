import {test, expect} from '@playwright/test';

// End-to-end smoothness regression net. Drives the app through to the
// running plot with fake audio, then observes main-thread frame pacing
// for 60 seconds. Main-thread rAF is expected to be very clean because
// the paint loop runs in the plot worker; this test catches regressions
// in the frame handler, React state, or any other main-thread-resident
// hot path.
//
// heuristic: smoothness-budget

const OBSERVATION_MS = 60_000;
const P99_FRAME_GAP_BUDGET_MS = 20;
const MAX_FRAME_GAP_BUDGET_MS = 50;
const LONGTASK_BUDGET = 0;
const HEAP_DELTA_BUDGET_BYTES = 600 * 1024;

test('pitch plot is smooth for 60 seconds', async ({page, context}) => {
    // Chromium's --use-fake-device-for-media-stream exposes one fake
    // audio input; the app gates the Start button on devices.length >=
    // 2. Inject an enumerateDevices shim that returns two synthetic
    // audioinput entries, and strip deviceId constraints from
    // getUserMedia so Chromium's fake-device pipeline still resolves
    // the audio stream regardless of which synthetic id the app picks.
    await context.addInitScript(() => {
        const md = navigator.mediaDevices;
        const originalEnumerate = md.enumerateDevices.bind(md);
        md.enumerateDevices = async function () {
            const real = await originalEnumerate();
            const audioInputCount = real.filter((d) => d.kind === 'audioinput').length;
            if (audioInputCount >= 2) {
                return real;
            }
            const makeFake = (deviceId: string, label: string): MediaDeviceInfo => ({
                deviceId,
                groupId: 'fake-group',
                kind: 'audioinput',
                label,
                toJSON() {
                    return this;
                },
            }) as MediaDeviceInfo;
            const others = real.filter((d) => d.kind !== 'audioinput');

            return [...others, makeFake('fake-audio-1', 'Fake Mic 1'), makeFake('fake-audio-2', 'Fake Mic 2')];
        };
        const originalGetUserMedia = md.getUserMedia.bind(md);
        md.getUserMedia = function (constraints?: MediaStreamConstraints) {
            if (constraints && typeof constraints.audio === 'object') {
                const audio = {...(constraints.audio as MediaTrackConstraints)};
                delete (audio as Record<string, unknown>).deviceId;

                return originalGetUserMedia({...constraints, audio});
            }

            return originalGetUserMedia(constraints);
        };
    });

    await page.goto('/');

    // DeviceSetup renders a single "Start" button once two audio
    // inputs are visible. Wait for it with a generous timeout because
    // the probe getUserMedia() call plus enumerateDevices() takes a
    // moment on first page load.
    const startButton = page.getByRole('button', {name: /^start$/i});
    await expect(startButton).toBeVisible({timeout: 15_000});
    await startButton.click();
    await expect(page.locator('canvas')).toBeVisible();
    await page.waitForTimeout(1500);

    const result = await page.evaluate(async (observationMs: number) => {
        interface PerfWithMemory extends Performance {
            memory?: {usedJSHeapSize: number};
        }
        const perfMem = performance as PerfWithMemory;
        const supportsMemory = Boolean(perfMem.memory);
        const supportsGc = typeof (globalThis as {gc?: () => void}).gc === 'function';

        if (supportsGc) {
            (globalThis as {gc?: () => void}).gc!();
        }
        const heapBaseline = supportsMemory ? perfMem.memory!.usedJSHeapSize : 0;

        const gaps: number[] = [];
        const longtasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                longtasks.push(entry.duration);
            }
        });
        observer.observe({entryTypes: ['longtask']});

        let lastTs = performance.now();
        const startTs = lastTs;
        await new Promise<void>((resolve) => {
            const tick = (ts: number) => {
                gaps.push(ts - lastTs);
                lastTs = ts;
                if (ts - startTs < observationMs) {
                    requestAnimationFrame(tick);

                    return;
                }
                resolve();
            };
            requestAnimationFrame(tick);
        });
        observer.disconnect();

        if (supportsGc) {
            (globalThis as {gc?: () => void}).gc!();
        }
        const heapAfter = supportsMemory ? perfMem.memory!.usedJSHeapSize : 0;

        gaps.sort((a, b) => a - b);
        const p99 = gaps[Math.floor(gaps.length * 0.99)] ?? 0;
        const max = gaps[gaps.length - 1] ?? 0;

        return {
            p99,
            max,
            longtaskCount: longtasks.length,
            heapDelta: supportsMemory ? heapAfter - heapBaseline : -1,
            heapMeasured: supportsMemory,
        };
    }, OBSERVATION_MS);

    expect(result.p99).toBeLessThan(P99_FRAME_GAP_BUDGET_MS);
    expect(result.max).toBeLessThan(MAX_FRAME_GAP_BUDGET_MS);
    expect(result.longtaskCount).toBe(LONGTASK_BUDGET);
    if (result.heapMeasured) {
        expect(result.heapDelta).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);
    }
});
