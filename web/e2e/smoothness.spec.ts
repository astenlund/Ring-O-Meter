import {test, expect} from '@playwright/test';
import {
    RENDERER_ARMS,
    registerFakeAudioBeforeEach,
    run60sSmoothnessProbe,
    setupSmoothnessPage,
    withChordFanout,
} from './support/smoothness';
import {LATENCY_DRIFT_BUDGET_MS, runSuspendResumeProbe} from './support/suspendResumeProbe';

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
//      any paint-rate or long-task symptom. Probe body lives in
//      support/suspendResumeProbe.ts so future variants (rapid
//      double-suspend, suspend-during-measurement, resume after long
//      suspend) can share the latency-sampling / gap-bucketing
//      machinery.
//   3. "pitch plot is smooth for 30 minutes (...)" - long-window
//      diagnostic gated by PROTOTYPE_LONG=1, captures the rare freeze
//      class at a statistically meaningful scale.
//
// The staccato 60-second arm lives in staccato-smoothness.spec.ts
// (separate file because Playwright restricts test.use({launchOptions})
// to file scope, and we don't want to override the audio file for the
// suspend/resume and 30-min tests in this file).

// heuristic: smoothness-budget

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

    const result = await runSuspendResumeProbe(page);

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
