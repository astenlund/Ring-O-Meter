import {IDBFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it} from 'vitest';
import {mulberry32} from '../synth/seededRng';
import {neutralVoiceParams, type ChordParams} from '../synth/voiceParams';
import {openCalibrationStore, type CalibrationStore} from '../store/calibrationStore';
import {fitCoefficients} from '../fit/coefficients';
import {openCalibrationSession} from './calibrationSession';
import type {SessionConfig} from './protocolTypes';

function baseline(): ChordParams {
    return {voices: [neutralVoiceParams(220), neutralVoiceParams(277), neutralVoiceParams(330), neutralVoiceParams(392)]};
}

let store: CalibrationStore;
beforeEach(async () => {
    store = await openCalibrationStore(new IDBFactory());
});

describe('protocol -> fit contract', () => {
    it('recovers a positive slope from a seeded sweep with an injected preference', async () => {
        // Arrange: a sweep on one axis; the simulated listener prefers the
        // higher-sweepDelta variant (probability rises with sweepDelta).
        const cfg: SessionConfig = {
            listenerId: 'dev',
            seed: 7,
            selector: {mode: 'sweep', axis: 'pitchVariance.drift', targetVoiceIndex: 0, baseline: baseline(), deltas: [-3, -2, -1, 1, 2, 3], repeats: 30},
        };
        const s = openCalibrationSession(store, cfg);

        // A deterministic "listener" on a seeded mulberry32 (same shape as the
        // shipped coefficients.test.ts fixture): choose B with probability
        // sigmoid(1.5 * sweepDelta).
        const listener = mulberry32(4242);

        // Act
        for (let t = s.nextTrial(); t !== null; t = s.nextTrial()) {
            const delta = t.sweepDelta ?? 0;
            const pB = 1 / (1 + Math.exp(-(1.5 * delta)));
            const wantB = listener() < pB;
            const pick = t.presentationOrder[0] === (wantB ? 'B' : 'A') ? 'first' : 'second';
            await s.recordChoice(t, pick);
        }

        const {rows} = await store.getAllTrials();
        const result = fitCoefficients(rows);

        // Assert
        const fit = result.get('pitchVariance.drift');
        expect(fit).toBeDefined();
        expect(fit!.status === 'ok' || fit!.status === 'saturated').toBe(true);
        if (fit!.status === 'ok' || fit!.status === 'saturated') {
            expect(fit!.slope).toBeGreaterThan(0.3); // concrete floor: a sign or bridge regression fails this loudly
        }
    });
});
