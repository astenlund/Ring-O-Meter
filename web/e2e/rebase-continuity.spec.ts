import {test, expect} from '@playwright/test';
import {registerFakeAudioDevicesBeforeEach} from './support/fakeAudioDevices';
import {
    LATENCY_DRIFT_BUDGET_MS,
    armChannelTestBridgeBeforeEach,
    runSuspendResumeProbe,
} from './support/suspendResumeProbe';

// Content-level invariant covering AudioContext suspend/resume rebase
// correctness. Catches the offset-miscomputation failure mode (cause
// (a) of the residual-snap-backs bug) that the smoothness assertions
// in smoothness.spec.ts cannot see: a wrong offset produces a
// spatially-warped trace without any paint-rate or long-task symptom.
//
// Lives in its own file (not bundled with the smoothness arms) because
// it has different setup needs (this spec arms the channel test bridge
// to read AudioContext + reader + rebaseCount from the page realm; the
// smoothness arms don't read the bridge), runs at a different cadence
// (one observation, not parameterised over renderer arms), and
// asserts a different invariant (rebase math, not frame pacing).
// Scaffolding for future suspend/resume probe variants (rapid double-
// suspend, suspend-during-measurement-window, resume after long
// suspend) lands here alongside this one rather than expanding the
// smoothness file's responsibility.

registerFakeAudioDevicesBeforeEach();
armChannelTestBridgeBeforeEach();

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
