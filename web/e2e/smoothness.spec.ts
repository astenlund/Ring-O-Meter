import {test, expect} from '@playwright/test';
import {CHANNEL_BRIDGE_KEY} from '../src/__testing/channelBridge';

// End-to-end regression net covering two distinct invariants, both
// driven through the same fake-audio harness:
//
//   1. "pitch plot is smooth for 60 seconds" - main-thread frame pacing.
//      rAF is expected to be very clean because the paint loop runs in
//      the plot worker; this test catches regressions in the frame
//      handler, React state, or any other main-thread-resident hot path.
//   2. "pitch plot stays in sync across suspend/resume rebase" -
//      AudioContext suspend/resume rebase correctness. Catches the
//      offset miscomputation failure mode (cause (a) of the
//      residual-snap-backs bug) that the smoothness assertion cannot
//      see: a wrong offset produces a spatially-warped trace without
//      any paint-rate or long-task symptom.
//
// heuristic: smoothness-budget

const OBSERVATION_MS = 60_000;
const P99_FRAME_GAP_BUDGET_MS = 20;
const MAX_FRAME_GAP_BUDGET_MS = 50;
const LONGTASK_BUDGET = 0;
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
const HEAP_DELTA_BUDGET_BYTES = 600 * 1024;

// Engineering budget: latency = perf.now() - (captureContextMs +
// offsetMs) on a fresh sample. When the rebase offset is correct, this
// equals the audio buffer duration (~20-50 ms) regardless of suspend
// count. A miscomputed offset by N ms shifts the post-resume median
// latency by N ms, which breaks |latency_post - latency_pre| < budget.
// 50 ms = one YIN analysis window at 2048 samples / 48 kHz (42.67 ms,
// rounded up); tight enough to catch real offset drift, loose enough
// to absorb audio-buffer jitter.
const LATENCY_DRIFT_BUDGET_MS = 50;

// Engineering budget: rAF gaps longer than this count as paint freezes.
// Looser than the 60s test's 50 ms because the suspend/resume test has
// a shorter observation window and a fresh worklet ramp-up after
// resume; the 60s test is the primary regression net for steady-state
// pacing.
const LONG_GAP_MS = 100;

// Engineering budget: how long after resume() fires we forgive as
// worklet ramp-up before expecting clean paint pacing again. Paint
// legitimately stalls inside [tSuspend, tResume + POST_RESUME_GUARD_MS],
// so gaps in that window are classified as expected, not as regressions.
const POST_RESUME_GUARD_MS = 200;

// Arm the test bridge and mock the media-device surface for every test
// in this file. Chromium's --use-fake-device-for-media-stream exposes
// one fake audio input; the app now also runs in single-mic mode, but
// these tests exercise the two-slot rendering path so we shim
// enumerateDevices to return two synthetic audioinputs and strip
// deviceId constraints from getUserMedia so the fake-device pipeline
// still resolves regardless of which synthetic id the app picks. The
// bridge map is consumed by the suspend/resume test; the first test
// ignores it, but arming once in beforeEach keeps the two tests' setup
// paths identical.
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

// Renderer arms for the parameterized smoothness test below. The 2D
// arm is the production path; the WebGPU arm exercises the prototype
// worker (web/src/plot/plotWorkerWebgpu.ts) under
// .claude/specs/2026-04-30-webgpu-plot-prototype.md and produces the
// p99 / max / longtask / heap-delta numbers the spec's decision tree
// consumes. The WebGPU arm hard-asserts a usable adapter before
// measuring; a missing flag (or otherwise-broken WebGPU) fails the
// test rather than silently rubber-stamping the comparison against a
// worker whose init() threw.
const RENDERER_ARMS = [
    {label: '2D canvas', querystring: ''},
    {label: 'WebGPU', querystring: '?renderer=webgpu'},
] as const;

for (const arm of RENDERER_ARMS) {
    test(`pitch plot is smooth for 60 seconds (${arm.label})`, async ({page}) => {
        await page.goto(`/${arm.querystring}`);

        if (arm.label === 'WebGPU') {
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

        // Per-arm reporter line: the prototype's primary numeric
        // output; consumed by the spec's "Prototype results" section
        // and the BUGS.md decision tree (Option C / D / inconclusive).
         
        console.log(`[smoothness:${arm.label}] p99=${result.p99}ms max=${result.max}ms longtasks=${result.longtaskCount} heapDelta=${result.heapDelta}B`);

        expect(result.p99).toBeLessThan(P99_FRAME_GAP_BUDGET_MS);
        expect(result.max).toBeLessThan(MAX_FRAME_GAP_BUDGET_MS);
        expect(result.longtaskCount).toBe(LONGTASK_BUDGET);
        if (result.heapMeasured) {
            expect(result.heapDelta).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);
        }
    });
}

test('pitch plot stays in sync across suspend/resume rebase', async ({page}) => {
    await page.goto('/');

    const startButton = page.getByRole('button', {name: /^start$/i});
    await expect(startButton).toBeVisible({timeout: 15_000});
    await startButton.click();
    await expect(page.locator('canvas').first()).toBeVisible();

    const result = await page.evaluate(
        async ({longGapMs, postResumeGuardMs, bridgeKey}) => {
            // Realm-boundary mirror of ChannelTestBridge / FrameRingReader
            // from web/src/__testing/channelBridge.ts. This evaluate body is
            // serialised into the browser realm and cannot import; the two
            // shapes must be kept in sync by hand. TestReader is the subset
            // of FrameRingReader this test actually consumes.
            interface TestReader {
                published(): number;
                forEach(
                    startMs: number,
                    cb: (tsMs: number, hz: number, conf: number) => void,
                ): void;
            }
            interface ChannelTestBridge {
                audioContext: AudioContext;
                reader: TestReader;
                rebaseCount: number;
            }
            const bridgeMap = (globalThis as Record<string, unknown>)[bridgeKey] as
                | Map<string, ChannelTestBridge>
                | undefined;
            if (!bridgeMap) {
                throw new Error(`${bridgeKey} is not armed on the page`);
            }

            // Step 1: poll for the post-click channel-registration. Up
            // to 5 s; channel creation is async after Start. The default
            // slot layout registers multiple channels on a shared
            // AudioContext (useVoiceChannels.ts:35); suspend/resume
            // affects them in lockstep, so any one bridge entry is a
            // representative probe.
            const popDeadline = performance.now() + 5000;
            while (bridgeMap.size === 0) {
                if (performance.now() > popDeadline) {
                    throw new Error('bridge map never populated within 5s of Start');
                }
                await new Promise((r) => setTimeout(r, 50));
            }
            const bridge = bridgeMap.values().next().value as ChannelTestBridge;
            const {audioContext, reader} = bridge;
            const rebaseCountBefore = bridge.rebaseCount;

            const median = (xs: number[]): number => {
                const finite = xs.filter((x) => Number.isFinite(x));
                if (finite.length === 0) {
                    return NaN;
                }
                const sorted = [...finite].sort((a, b) => a - b);

                return sorted[Math.floor(sorted.length / 2)];
            };

            // Sample the newest-in-window tsMs via forEach; oldest-first
            // iteration means the final callback write to `lastTsMs` is
            // the newest sample. 500 ms window is generous against the
            // per-channel ~47 Hz publish cadence.
            const sampleLatency = (): number => {
                let lastTsMs = NaN;
                reader.forEach(performance.now() - 500, (tsMs) => {
                    lastTsMs = tsMs;
                });

                return performance.now() - lastTsMs;
            };

            const gaps: {ts: number; gap: number}[] = [];
            let lastRaf = performance.now();

            const runRaf = (
                durationMs: number,
                onTick: (ts: number) => void,
            ): Promise<void> => {
                return new Promise((resolve) => {
                    const startRaf = performance.now();
                    const tick = (ts: number) => {
                        gaps.push({ts, gap: ts - lastRaf});
                        lastRaf = ts;
                        onTick(ts);
                        if (ts - startRaf < durationMs) {
                            requestAnimationFrame(tick);

                            return;
                        }
                        resolve();
                    };
                    requestAnimationFrame(tick);
                });
            };

            // Runs runRaf for `totalMs` and pushes `sampleLatency()` to a
            // fresh array during the final `sampleTailMs` of the window.
            // Collapses the otherwise-identical pre-suspend / post-resume
            // measurement blocks to two lines each. Gaps go into the
            // outer `gaps` array the same way as before.
            const measureLatencyWindow = async (
                totalMs: number,
                sampleTailMs: number,
            ): Promise<number[]> => {
                const latencies: number[] = [];
                const samplingStart = performance.now() + (totalMs - sampleTailMs);
                await runRaf(totalMs, (ts) => {
                    if (ts >= samplingStart) {
                        latencies.push(sampleLatency());
                    }
                });

                return latencies;
            };

            // Step 2: 2000 ms warmup, sample latency in the final 500 ms.
            // Reads pre-rebase offsetMs (setOffset has not run yet for
            // the post-resume rebase cycle).
            const preLatencies = await measureLatencyWindow(2000, 500);
            const latencyPre = median(preLatencies);
            const preSuspendPublished = reader.published();
            const tSuspend = performance.now();

            // Step 3: suspend + sleep.
            await audioContext.suspend();
            await new Promise((r) => setTimeout(r, 2000));

            // Step 4: resume. Wait for BOTH the rebase counter to tick
            // (proves handleStateChange has run and setOffset has been
            // applied) AND the reader to have new published frames
            // under the new offset. The rebaseCount check specifically
            // prevents racing statechange listener order against the
            // resume() promise resolving.
            await audioContext.resume();
            const tResume = performance.now();
            const resumeDeadline = performance.now() + 2000;
            while (
                bridge.rebaseCount <= rebaseCountBefore
                || reader.published() < preSuspendPublished + 20
            ) {
                if (performance.now() > resumeDeadline) {
                    throw new Error(
                        'post-resume preconditions never held: '
                            + `rebaseCount=${bridge.rebaseCount} (before=${rebaseCountBefore}), `
                            + `published=${reader.published()} (target=${preSuspendPublished + 20})`,
                    );
                }
                await new Promise((r) => setTimeout(r, 20));
            }

            // Step 5: 5000 ms post-resume, sample latency in final 1000 ms.
            // lastRaf is reset so the first post-resume gap is measured
            // against now (not against the pre-suspend tail), otherwise
            // the gap in [tSuspend, tResume] would show up as one giant
            // paint freeze on the first post-resume tick.
            lastRaf = performance.now();
            const postLatencies = await measureLatencyWindow(5000, 1000);
            const latencyPost = median(postLatencies);

            // Step 6: bucket rAF gaps by phase. Gaps inside the
            // suspend/resume window are expected (paint legitimately
            // stalls while the worklet is paused) and skipped; only
            // pre-suspend and post-resume-plus-guard gaps are counted
            // against the longGapMs budget.
            let preGaps = 0;
            let postGaps = 0;
            for (const {ts, gap} of gaps) {
                if (gap <= longGapMs) {
                    continue;
                }
                const inSuspendedWindow = ts >= tSuspend && ts <= tResume + postResumeGuardMs;
                if (inSuspendedWindow) {
                    continue;
                }
                if (ts < tSuspend) {
                    preGaps += 1;
                } else {
                    postGaps += 1;
                }
            }

            return {
                latencyPre,
                latencyPost,
                preGaps,
                postGaps,
                rebaseCountBefore,
                rebaseCountAfter: bridge.rebaseCount,
                preLatencySamples: preLatencies.length,
                postLatencySamples: postLatencies.length,
                preSuspendPublished,
                postResumePublished: reader.published(),
            };
        },
        {longGapMs: LONG_GAP_MS, postResumeGuardMs: POST_RESUME_GUARD_MS, bridgeKey: CHANNEL_BRIDGE_KEY},
    );

    // Preconditions: measurement windows produced useful samples, the
    // rebase observably fired on the post-resume transition.
    expect(result.preLatencySamples).toBeGreaterThan(5);
    expect(result.postLatencySamples).toBeGreaterThan(5);
    expect(result.rebaseCountAfter).toBeGreaterThan(result.rebaseCountBefore);
    expect(result.postResumePublished).toBeGreaterThan(result.preSuspendPublished);

    // Main invariant: rebase offset continuity. A miscomputed offset
    // shifts the post-resume median latency by the miscomputation
    // magnitude, regardless of which direction.
    expect(Math.abs(result.latencyPost - result.latencyPre)).toBeLessThan(LATENCY_DRIFT_BUDGET_MS);

    // Paint smoothness pre and post. During-suspend is intentionally
    // unasserted: paint stalling while the worklet is paused is
    // expected behaviour, not a regression.
    expect(result.preGaps).toBe(0);
    expect(result.postGaps).toBe(0);
});

// Long-window diagnostic arm for the WebGPU plot prototype
// (.claude/specs/2026-04-30-webgpu-plot-prototype.md). The 60 s
// regression net above catches steady-state pacing drift but cannot
// reach the rare freeze class (~3 per 15 min) that originally
// motivated the prototype. This 30-min loop reproduces that class at
// a window where the count is statistically meaningful, emits
// per-arm freeze counts and timestamps to the reporter, and DOES
// NOT assert against a budget - the prototype is a diagnostic, not
// a regression net at this scale. Numbers feed the spec's
// "Prototype results" section and decision tree (Option C / D /
// inconclusive). Gated by PROTOTYPE_LONG=1 so it does not run on
// normal `pnpm test:e2e`; standard suite stays at ~2 min total.
//
// Run: PROTOTYPE_LONG=1 pnpm --dir web exec playwright test e2e/smoothness.spec.ts -g "30 minutes"
const LONG_OBSERVATION_MS = 30 * 60 * 1000;
const FREEZE_THRESHOLD_MS = 200;

if (process.env.PROTOTYPE_LONG === '1') {
    for (const arm of RENDERER_ARMS) {
        test(`pitch plot is smooth for 30 minutes (${arm.label})`, async ({page}) => {
            // Playwright's default per-test timeout (180_000 in
            // playwright.config.ts) would fail this run at 0.6%
            // completion. Extend just this test by the observation
            // window plus 60 s headroom for setup, teardown, and
            // post-loop reporter writes.
            test.setTimeout(LONG_OBSERVATION_MS + 60_000);
            await page.goto(`/${arm.querystring}`);

            if (arm.label === 'WebGPU') {
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

            const startButton = page.getByRole('button', {name: /^start$/i});
            await expect(startButton).toBeVisible({timeout: 15_000});
            await startButton.click();
            await expect(page.locator('canvas').first()).toBeVisible();
            await page.waitForTimeout(1500);

            const result = await page.evaluate(
                async ({observationMs, freezeThresholdMs}) => {
                    const longGaps: {ts: number; gap: number}[] = [];
                    let lastTs = performance.now();
                    const startTs = lastTs;
                    await new Promise<void>((resolve) => {
                        const tick = (ts: number) => {
                            const gap = ts - lastTs;
                            if (gap > freezeThresholdMs) {
                                longGaps.push({ts: ts - startTs, gap});
                            }
                            lastTs = ts;
                            if (ts - startTs < observationMs) {
                                requestAnimationFrame(tick);

                                return;
                            }
                            resolve();
                        };
                        requestAnimationFrame(tick);
                    });

                    return {longGaps, durationMs: performance.now() - startTs};
                },
                {observationMs: LONG_OBSERVATION_MS, freezeThresholdMs: FREEZE_THRESHOLD_MS},
            );

            // Reporter output: header line plus one line per freeze.
            // Numbers get pasted into
            // .claude/specs/2026-04-30-webgpu-plot-prototype.md
            // "Prototype results" -> "Long-window freeze count" column.

            console.log(`[long-smoothness:${arm.label}] freezes=${result.longGaps.length} over ${(result.durationMs / 1000).toFixed(0)}s`);
            for (const f of result.longGaps) {

                console.log(`  ${f.ts.toFixed(0)}ms: ${f.gap.toFixed(0)}ms gap`);
            }
            // No expect() against freeze count. The prototype is a
            // diagnostic at this scale; a budget would either rubber-
            // stamp noise or false-fail on legitimate Iris Xe
            // residual. Spec's decision tree consumes the raw counts.
        });
    }
}

