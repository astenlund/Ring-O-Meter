import {test, expect} from '@playwright/test';
import {registerFakeAudioDevicesBeforeEach} from './support/fakeAudioDevices';
import {withChordFanout} from './support/smoothness';

// End-to-end behaviour spec for ChordAwareDisplay.
//
// Two arms:
//
//   1. "dom7 fanout behaviour" - verifies that the chord classifier
//      correctly identifies the JI dom7 chord produced by ?fanout=4
//      (DominantSeventh = 1) and that each voice's residual is within
//      ±2 ¢ of 0. Requires devModesEnabled: true so the fanout flag
//      is honoured; intercepted via page.route before navigation.
//
//   2. "production-bundle guard" - verifies that when devModesEnabled
//      is false (production config), ?fanout=4 is silently ignored
//      (single-voice path) and ?renderer=trace falls back to the
//      WebGPU default. Each ignored flag emits exactly one
//      console.warn line per page load.
//
// Neither arm is battery-sensitive: neither arm runs a 60-second
// frame-gap measurement, so the AC-power guard from the smoothness
// spec does not apply here.

// heuristic: chord-aware-display-e2e-cents-tolerance
const CENTS_TOLERANCE = 2;
// Maximum time (ms) to wait for the chord classifier to lock after
// audio starts. The classifier runs at ~15 Hz; HYSTERESIS_FRAMES=2
// means 3 frames must agree. Worst-case: 200 ms per frame * 3 = 600 ms.
// A 10-second budget absorbs startup jitter and fake-audio device
// initialisation without making the suite slow.
// heuristic: chord-aware-display-e2e-lock-timeout
const CHORD_LOCK_TIMEOUT_MS = 10_000;
// Generous settle time after Start is clicked: worklet initialisation
// + SAB population + first classification coalesce.
// heuristic: chord-aware-display-e2e-settle-ms
const SETTLE_MS = 3_000;

registerFakeAudioDevicesBeforeEach();

// ---------------------------------------------------------------------------
// Task 23: dom7 fanout behaviour
// ---------------------------------------------------------------------------

test('chord-aware-display identifies dom7 and reports near-zero residuals', async ({page}) => {
    // Intercept /config.json before navigation so devModesEnabled: true
    // reaches App before parseFanoutFlag runs. Without this intercept the
    // preview server 404s config.json → fail-closed → fanout silently
    // ignored → single-voice path → ChordAwareDisplay never locked.
    await page.route('**/config.json', (route) => {
        void route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({hubUrl: '', devModesEnabled: true}),
        });
    });

    // withChordFanout('') produces a ?fanout=4 query with ratio-precise
    // JI dom7 offsets (0 / 1200*log2(5/4) / 1200*log2(3/2) / 1200*log2(7/4))
    // exercising the canonical barbershop chord (A3/C#4/E4/G4).
    await page.goto(withChordFanout(''));

    const startButton = page.getByRole('button', {name: /^start$/i});
    await expect(startButton).toBeVisible({timeout: 15_000});
    await startButton.click();

    // Wait for the chord-aware-display wrapper to appear. The outer div
    // carries data-chord-type; it renders as soon as ChordAwareDisplay
    // mounts (chord=null is valid initial state). The attribute value
    // updates once the classifier locks.
    await expect(page.locator('[data-chord-type]')).toBeVisible({timeout: 15_000});

    // Allow the worklet to publish frames and the classifier to lock before
    // reading the classification result.
    await page.waitForTimeout(SETTLE_MS);

    // ChordType.DominantSeventh = 1 (wire contract from wire/chord.ts).
    // The fanout fixture applies ratio-precise JI cent offsets for
    // root / maj-3 / P5 / harmonic-7 of the dom7 chord — zero residuals
    // by construction, so the classifier must lock on DominantSeventh.
    await expect(page.locator('[data-chord-type]')).toHaveAttribute(
        'data-chord-type',
        '1',
        {timeout: CHORD_LOCK_TIMEOUT_MS},
    );

    // Four [data-voice-id] rows are emitted by ChordAwareDisplay for the
    // four fanout voices. Each carries data-cents set by residualsPerVoice
    // from the chord classifier. At perfect JI offsets the residuals should
    // converge near 0; allow ±CENTS_TOLERANCE to absorb pipeline jitter.
    const voiceRows = page.locator('[data-voice-id]');
    await expect(voiceRows).toHaveCount(4, {timeout: CHORD_LOCK_TIMEOUT_MS});

    const centsValues = await voiceRows.evaluateAll((rows) =>
        rows.map((row) => {
            const raw = (row as HTMLElement).dataset.cents;

            return raw !== undefined ? Number(raw) : null;
        }),
    );

    for (const cents of centsValues) {
        expect(cents, `expected data-cents near 0, got ${cents}`).not.toBeNull();
        expect(Math.abs(cents!)).toBeLessThanOrEqual(CENTS_TOLERANCE);
    }
});

// ---------------------------------------------------------------------------
// Task 24: production-bundle guard
// ---------------------------------------------------------------------------

test('production config suppresses ?fanout and ?renderer=trace with one-shot warnings', async ({page}) => {
    const warnMessages: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'warning') {
            warnMessages.push(msg.text());
        }
    });

    // Intercept /config.json to return the production fail-closed config.
    // Both parseFanoutFlag and parseRendererFlag check devModesEnabled
    // before honouring their flags; false → ignored, one-shot warn.
    await page.route('**/config.json', (route) => {
        void route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({hubUrl: '', devModesEnabled: false}),
        });
    });

    // Visit ?fanout=4 with devModesEnabled: false. parseFanoutFlag emits a
    // one-shot console.warn and returns null → production single-voice path.
    await page.goto(withChordFanout(''));

    const startButton = page.getByRole('button', {name: /^start$/i});
    await expect(startButton).toBeVisible({timeout: 15_000});
    await startButton.click();

    // Production path: exactly one [data-voice-id] row (single mic slot).
    // ChordAwareDisplay must be mounted; we assert via the stable
    // data-component mount marker because data-chord-type only sets when
    // a chord is locked (and a single voice never locks).
    await expect(page.locator('[data-component="chord-aware-display"]')).toBeAttached({timeout: 15_000});
    // Allow slots to populate.
    await page.waitForTimeout(SETTLE_MS);
    await expect(page.locator('[data-voice-id]')).toHaveCount(1, {timeout: CHORD_LOCK_TIMEOUT_MS});

    // Exactly one fanout-ignored warning so far (one-shot latch in
    // parseFanoutFlag fires on the first call only).
    const fanoutWarns = warnMessages.filter((m) => m.includes('?fanout flag ignored'));
    expect(fanoutWarns).toHaveLength(1);

    // Now navigate to ?renderer=trace with the same production config to
    // verify parseRendererFlag also suppresses the flag and warns once.
    // page.route intercepts persist for the page lifetime, so the same
    // config intercept is still active.
    await page.goto('/?renderer=trace');

    // Wait for the app to re-render and parsers to run.
    const startButton2 = page.getByRole('button', {name: /^start$/i});
    await expect(startButton2).toBeVisible({timeout: 15_000});
    await startButton2.click();

    // ChordAwareDisplay renders when renderer.kind !== 'trace' (App.tsx).
    // When the trace flag is suppressed (devModesEnabled: false) renderer.kind
    // falls back to 'webgpu', so ChordAwareDisplay IS rendered. If the trace
    // flag were honoured (devModesEnabled: true) ChordAwareDisplay would be
    // hidden. Presence of the data-component mount marker therefore
    // asserts trace was NOT activated.
    await expect(page.locator('[data-component="chord-aware-display"]')).toBeAttached({timeout: 15_000});

    // One-shot renderer warn fires exactly once per page load. page.goto
    // ('/?renderer=trace') is a hard navigation that reloads the JS bundle,
    // resetting the module-level `_warnedAboutIgnoredRenderer` latch, so
    // the warn fires exactly once for this navigation.
    const rendererWarns = warnMessages.filter((m) =>
        m.includes('?renderer=trace ignored'),
    );
    expect(rendererWarns).toHaveLength(1);
});
