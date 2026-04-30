import {test, expect, type Page} from '@playwright/test';
import {CHANNEL_BRIDGE_KEY} from '../../src/__testing/channelBridge';

// Shared bits for the 60-second smoothness regression net. Hosts the
// budgets, the renderer-arm parameterisation, the fake-audio
// beforeEach shim, and the probe body. Imported by both
// `smoothness.spec.ts` (sustained-tone fixture, the global
// playwright.config.ts audioFile) and
// `staccato-smoothness.spec.ts` (staccato-tone fixture, top-level
// test.use launchOptions override).

// heuristic: smoothness-budget
export const OBSERVATION_MS = 60_000;
export const P99_FRAME_GAP_BUDGET_MS = 20;
export const MAX_FRAME_GAP_BUDGET_MS = 50;
export const LONGTASK_BUDGET = 0;
// 600 KB = measured_clean_run * ~1.6 (two local runs at ~370 KB,
// ~1% variance). This e2e delta measures the whole app's 60 s
// churn - React reconciles from useFrameState flushes, rAF closures,
// V8 heap-ratchet slack, FrameRingReader.readLatest's UiFrame
// literal - NOT just the per-frame pipeline that the per-module
// alloc tests cover in isolation. Do not calibrate this by summing
// the per-module budgets; those answer a narrower question. Target
// per the hot-path-allocation-discipline pattern:
// `measured_clean_run * 1.5` after three green CI runs. Ratchet
// down only when a churn-reduction change has landed AND three CI
// runs confirm the new baseline.
export const HEAP_DELTA_BUDGET_BYTES = 600 * 1024;

// Renderer arms for the parameterised smoothness test. As of
// 2026-04-30 WebGPU is the production default; the 2D arm is the
// opt-out fallback selected via ?renderer=2d. Both arms are real
// production paths now and the smoothness budgets apply to both.
export const RENDERER_ARMS = [
    {label: 'WebGPU (default)', querystring: ''},
    {label: '2D canvas (opt-out)', querystring: '?renderer=2d'},
] as const;

// beforeEach shim that arms the channel test bridge and mocks the
// media-device surface so single-fake-audio-input Chromium presents
// as two synthetic audioinputs (the test exercises the two-slot
// rendering path) and getUserMedia resolves regardless of which
// synthetic deviceId the app picks. Call once at the top of each
// spec file that uses run60sSmoothnessProbe.
export function registerFakeAudioBeforeEach(): void {
    test.beforeEach(async ({context}) => {
        await context.addInitScript((bridgeKey: string) => {
            (globalThis as Record<string, unknown>)[bridgeKey] = new Map();

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
        }, CHANNEL_BRIDGE_KEY);
    });
}

// 60-second smoothness probe shared between the sustained and
// staccato fixture spec files. Same precondition (WebGPU adapter
// check on the WebGPU arm), same measurement, same budgets; only
// the audio-capture file (and therefore the singing waveform
// reaching the YIN detector) differs across callers.
export async function run60sSmoothnessProbe(
    page: Page,
    fixtureLabel: string,
    armLabel: string,
    querystring: string,
): Promise<void> {
    await page.goto(`/${querystring}`);

    if (armLabel === 'WebGPU (default)') {
        // navigator.gpu is non-null on stock Chromium regardless
        // of --enable-unsafe-webgpu; the flag affects what
        // requestAdapter() returns on Windows. Probe the adapter
        // directly so a missing flag (or otherwise-broken WebGPU)
        // hard-fails the test instead of silently rubber-stamping
        // the comparison against a worker whose init() threw.
        const hasAdapter = await page.evaluate(async () => {
            if (!navigator.gpu) {
                return false;
            }
            const adapter = await navigator.gpu.requestAdapter();

            return adapter !== null;
        });
        expect(
            hasAdapter,
            'WebGPU arm requires a usable adapter; check Playwright Chromium launch args (--enable-unsafe-webgpu) and host WebGPU support',
        ).toBe(true);
    }

    // DeviceSetup renders a single "Start" button once two audio
    // inputs are visible. Wait for it with a generous timeout because
    // the probe getUserMedia() call plus enumerateDevices() takes a
    // moment on first page load.
    const startButton = page.getByRole('button', {name: /^start$/i});
    await expect(startButton).toBeVisible({timeout: 15_000});
    await startButton.click();
    // Two canvases (underlay + main) when useUnderlay is true on
    // the WebGPU arm; .first() matches either shape.
    await expect(page.locator('canvas').first()).toBeVisible();
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

    // Per-fixture-per-arm reporter line: feeds the spec's
    // "Prototype results" section.

    console.log(`[smoothness:${fixtureLabel}:${armLabel}] p99=${result.p99}ms max=${result.max}ms longtasks=${result.longtaskCount} heapDelta=${result.heapDelta}B`);

    expect(result.p99).toBeLessThan(P99_FRAME_GAP_BUDGET_MS);
    expect(result.max).toBeLessThan(MAX_FRAME_GAP_BUDGET_MS);
    expect(result.longtaskCount).toBe(LONGTASK_BUDGET);
    if (result.heapMeasured) {
        expect(result.heapDelta).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);
    }
}
