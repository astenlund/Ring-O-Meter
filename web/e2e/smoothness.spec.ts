import {test, expect} from '@playwright/test';
import {CHANNEL_BRIDGE_KEY} from '../src/audio/channelBridge';
import {
    RENDERER_ARMS,
    registerFakeAudioBeforeEach,
    run60sSmoothnessProbe,
    setupSmoothnessPage,
    withChordFanout,
} from './support/smoothness';

// End-to-end regression net covering three distinct invariants, all
// driven through the same fake-audio harness:
//
//   1. "pitch plot is smooth for 60 seconds (sustained, ...)" -
//      main-thread frame pacing on the steady-state singing workload.
//      Both renderers (WebGPU default, 2D opt-out) tested. The probe
//      body lives in support/smoothness.ts and is shared with the
//      staccato fixture spec file.
//   2. "pitch plot stays in sync across suspend/resume rebase" -
//      AudioContext suspend/resume rebase correctness. Catches the
//      offset miscomputation failure mode (cause (a) of the
//      residual-snap-backs bug) that the smoothness assertion cannot
//      see: a wrong offset produces a spatially-warped trace without
//      any paint-rate or long-task symptom.
//   3. "pitch plot is smooth for 30 minutes (...)" - long-window
//      diagnostic gated by PROTOTYPE_LONG=1, captures the rare freeze
//      class at a statistically meaningful scale.
//
// The staccato 60-second arm lives in staccato-smoothness.spec.ts
// (separate file because Playwright restricts test.use({launchOptions})
// to file scope, and we don't want to override the audio file for the
// suspend/resume and 30-min tests in this file).

// heuristic: smoothness-budget

// Engineering budget: latency = perf.now() - (captureContextMs +
// offsetMs) on a fresh sample. When the rebase offset is correct, this
// equals the audio buffer duration (~20-50 ms) regardless of suspend
// count. A miscomputed offset by N ms shifts the post-resume median
// latency by N ms, which breaks |latency_post - latency_pre| < budget.
// 100 ms catches real rebase-math regressions while absorbing the
// post-resume settling-frame cost that the vowel-graph slice's added
// pipeline (vowelModule.update + extra render pass + per-voice
// debounce state) introduces. Ratcheted from 50 ms (calibrated for
// the pre-vowel pipeline; 1 YIN analysis window at 2048 samples /
// 48 kHz = 42.67 ms, rounded up) on 2026-05-04 per the
// hot-path-allocation-discipline pattern's "calibrate after
// measurement" convention. Two reproductions on the testbed laptop
// landed at 62 ms and 77 ms respectively; 100 ms gives ~1.3x headroom
// on the worst observed and still catches obvious miscomputations
// (a broken rebase formula would produce drifts >>100 ms).
const LATENCY_DRIFT_BUDGET_MS = 100;

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

registerFakeAudioBeforeEach();

// Sustained 4-voice "barbershop seven" chord arm: the smoothness
// regression net's primary smoothness fixture. Both renderers
// (WebGPU default, 2D opt-out) tested. Single-voice variants were
// dropped 2026-04-30 in favour of the 4-voice chord since (a) the
// prototype's eventual production configuration is a four-singer
// quartet, (b) the chord is the canonical "ring" moment in
// barbershop, and (c) under fanout the rendering load is 4x but
// the audio analysis cost is unchanged - so the test specifically
// stresses the rendering layer, which is what we care about
// regression-locking. Staccato variant lives in
// staccato-smoothness.spec.ts.
//
// FIXTURE_LABEL is the reporter token shared between the 60-second
// and 30-minute arms below; emitting the same string from both is
// what lets the spec's "Prototype results" section pair the
// numbers across observation windows. Single source of truth so
// the two arms can't drift on rename.
const FIXTURE_LABEL = 'dom7-sustained';

for (const arm of RENDERER_ARMS) {
    test(`pitch plot is smooth for 60 seconds (dom7 sustained, ${arm.label})`, async ({page}) => {
        await run60sSmoothnessProbe(page, FIXTURE_LABEL, arm, withChordFanout(arm.querystring));
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
            // from web/src/audio/channelBridge.ts. This evaluate body is
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
        test(`pitch plot is smooth for 30 minutes (dom7 sustained, ${arm.label})`, async ({page}) => {
            // Playwright's default per-test timeout (180_000 in
            // playwright.config.ts) would fail this run at 0.6%
            // completion. Extend just this test by the observation
            // window plus 60 s headroom for setup, teardown, and
            // post-loop reporter writes.
            test.setTimeout(LONG_OBSERVATION_MS + 60_000);
            await setupSmoothnessPage(page, arm, withChordFanout(arm.querystring));

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

            console.log(`[long-smoothness:${FIXTURE_LABEL}:${arm.label}] freezes=${result.longGaps.length} over ${(result.durationMs / 1000).toFixed(0)}s`);
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
