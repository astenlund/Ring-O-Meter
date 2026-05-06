import {test, type Page} from '@playwright/test';
import {CHANNEL_BRIDGE_KEY} from '../../src/audio/channelBridge';

// beforeEach hook that initializes the channel test bridge map on
// the page realm before each test. Spec files that read from the
// bridge (today: only the suspend/resume rebase-continuity probe)
// must call this; spec files that only run smoothness probes do
// not, since the smoothness probe body never touches the bridge.
export function armChannelTestBridgeBeforeEach(): void {
    test.beforeEach(async ({context}) => {
        await context.addInitScript((bridgeKey: string) => {
            (globalThis as Record<string, unknown>)[bridgeKey] = new Map();
        }, CHANNEL_BRIDGE_KEY);
    });
}

// Suspend/resume rebase-correctness probe. Extracted from
// smoothness.spec.ts so future probe variants (rapid double-suspend,
// suspend-during-measurement-window, resume after long suspend) can
// share the warmup / latency-sampling / gap-bucketing machinery
// without copy-pasting the ~190-line page.evaluate body.
//
// Engineering budget: latency = perf.now() - (captureContextMs +
// offsetMs) on a fresh sample. When the rebase offset is correct,
// this equals the audio buffer duration (~20-50 ms) regardless of
// suspend count. A miscomputed offset by N ms shifts the post-resume
// median latency by N ms, which breaks
// |latency_post - latency_pre| < budget.  100 ms catches real rebase-
// math regressions while absorbing the post-resume settling-frame
// cost that the vowel-graph slice's added pipeline (vowelModule.update
// + extra render pass + per-voice debounce state) introduces.
// Ratcheted from 50 ms (calibrated for the pre-vowel pipeline; 1 YIN
// analysis window at 2048 samples / 48 kHz = 42.67 ms, rounded up) on
// 2026-05-04 per the hot-path-allocation-discipline pattern's
// "calibrate after measurement" convention. Two reproductions on the
// testbed laptop landed at 62 ms and 77 ms respectively; 100 ms gives
// ~1.3x headroom on the worst observed and still catches obvious
// miscomputations (a broken rebase formula would produce drifts
// >>100 ms).
export const LATENCY_DRIFT_BUDGET_MS = 100;

// Engineering budget: rAF gaps longer than this count as paint
// freezes. Looser than the 60 s test's 50 ms because the suspend/
// resume test has a shorter observation window and a fresh worklet
// ramp-up after resume; the 60 s test is the primary regression net
// for steady-state pacing.
export const LONG_GAP_MS = 100;

// Engineering budget: how long after resume() fires we forgive as
// worklet ramp-up before expecting clean paint pacing again. Paint
// legitimately stalls inside [tSuspend, tResume + POST_RESUME_GUARD_MS],
// so gaps in that window are classified as expected, not as
// regressions.
export const POST_RESUME_GUARD_MS = 200;

export interface SuspendResumeProbeResult {
    readonly latencyPre: number;
    readonly latencyPost: number;
    readonly preGaps: number;
    readonly postGaps: number;
    readonly rebaseCountBefore: number;
    readonly rebaseCountAfter: number;
    readonly preLatencySamples: number;
    readonly postLatencySamples: number;
    readonly preSuspendPublished: number;
    readonly postResumePublished: number;
}

export interface SuspendResumeProbeOpts {
    readonly longGapMs?: number;
    readonly postResumeGuardMs?: number;
}

// Drives a single suspend/resume cycle on the page's AudioContext
// and returns latency + gap measurements pre- and post-rebase. The
// caller is expected to have already navigated, clicked Start, and
// waited for the canvas to mount; the bridge map is polled inside
// the page realm for up to 5 s after entry.
export async function runSuspendResumeProbe(
    page: Page,
    opts: SuspendResumeProbeOpts = {},
): Promise<SuspendResumeProbeResult> {
    const longGapMs = opts.longGapMs ?? LONG_GAP_MS;
    const postResumeGuardMs = opts.postResumeGuardMs ?? POST_RESUME_GUARD_MS;

    return page.evaluate(
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
        {longGapMs, postResumeGuardMs, bridgeKey: CHANNEL_BRIDGE_KEY},
    );
}
