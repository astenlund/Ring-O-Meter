import {IDBFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it} from 'vitest';
import {neutralVoiceParams, type ChordParams} from '../synth/voiceParams';
import {openCalibrationStore, type CalibrationStore} from '../store/calibrationStore';
import {CalibrationConfigError, ResampleExhaustedError, type PendingTrial, type SessionConfig} from './protocolTypes';
import {openCalibrationSession} from './calibrationSession';

function baseline(): ChordParams {
    return {voices: [neutralVoiceParams(220), neutralVoiceParams(277), neutralVoiceParams(330), neutralVoiceParams(392)]};
}

let store: CalibrationStore;
beforeEach(async () => {
    store = await openCalibrationStore(new IDBFactory());
});

function sweep(seed: number): SessionConfig {
    return {listenerId: 'dev', seed, selector: {mode: 'sweep', axis: 'pitchVariance.drift', targetVoiceIndex: 0, baseline: baseline(), deltas: [10, 20, 30], repeats: 2}};
}

describe('openCalibrationSession', () => {
    it('mints a sessionId and forwards the caller listenerId', () => {
        // Arrange / Act
        const s = openCalibrationSession(store, sweep(1));

        // Assert
        expect(s.sessionId).toMatch(/[0-9a-f-]{36}/);
        expect(s.listenerId).toBe('dev');
    });

    it('throws CalibrationConfigError on invalid config', () => {
        const bad = sweep(1);
        bad.selector = {...bad.selector, deltas: []} as SessionConfig['selector'];
        expect(() => openCalibrationSession(store, bad)).toThrow(CalibrationConfigError);
    });
});

describe('nextTrial - sweep', () => {
    it('emits exactly deltas.length * repeats trials then null', () => {
        // Arrange
        const s = openCalibrationSession(store, sweep(1));

        // Act
        let count = 0;
        while (s.nextTrial() !== null) {
            count += 1;
            if (count > 100) break; // guard against a non-terminating bug
        }

        // Assert
        expect(count).toBe(6); // 3 deltas * 2 repeats
    });

    it('produces sign-balanced sweepDelta and ~50/50 label + order over a large run', () => {
        // Arrange: many trials on a fixed seed
        const cfg = sweep(12345);
        cfg.selector = {...cfg.selector, deltas: [10], repeats: 1000} as SessionConfig['selector'];
        const s = openCalibrationSession(store, cfg);

        // Act
        let posDelta = 0;
        let aFirst = 0;
        let total = 0;
        for (let t = s.nextTrial(); t !== null; t = s.nextTrial()) {
            total += 1;
            if ((t.sweepDelta ?? 0) > 0) posDelta += 1;
            if (t.presentationOrder[0] === 'A') aFirst += 1;
        }

        // Assert: within a band a correct uniform draw clears but a broken one fails.
        expect(total).toBe(1000);
        expect(posDelta / total).toBeGreaterThan(0.45);
        expect(posDelta / total).toBeLessThan(0.55);
        expect(aFirst / total).toBeGreaterThan(0.45);
        expect(aFirst / total).toBeLessThan(0.55);
    });

    it('is reproducible from a fixed seed (seed-derived fields only)', () => {
        // Arrange: sessionId is a fresh crypto.randomUUID per session, so compare
        // only the seed-derived fields, NOT the whole PendingTrial.
        const seedFields = (t: PendingTrial) => ({
            sweepAxis: t.sweepAxis,
            sweepDelta: t.sweepDelta,
            chordA: t.chordA,
            chordB: t.chordB,
            seedA: t.seedA,
            seedB: t.seedB,
            presentationOrder: t.presentationOrder,
        });

        // Act
        const a = openCalibrationSession(store, sweep(99)).nextTrial()!;
        const b = openCalibrationSession(store, sweep(99)).nextTrial()!;

        // Assert
        expect(JSON.stringify(seedFields(a))).toBe(JSON.stringify(seedFields(b)));
    });

    it('writes null sweepAxis/sweepDelta for random mode', () => {
        // Arrange
        const cfg: SessionConfig = {listenerId: 'dev', seed: 1, selector: {mode: 'random', axis: 'formant.f1', targetVoiceIndex: 0, baseline: baseline(), range: {min: -50, max: 50}}};
        const s = openCalibrationSession(store, cfg);

        // Act
        const t = s.nextTrial();

        // Assert
        expect(t).not.toBeNull();
        expect(t?.sweepAxis).toBeNull();
        expect(t?.sweepDelta).toBeNull();
        expect(t?.selectorMode).toBe('random');
    });
});

describe('nextTrial - random confound', () => {
    it('throws ResampleExhaustedError when a tuning range cannot yield a clean pair', () => {
        // Arrange: a baseline whose formant sits exactly on the octave coincidence
        // for every tuning in a near-zero range, so every draw collides.
        const v0 = {...neutralVoiceParams(200), f1Hz: 400, f2Hz: 401};
        const cfg: SessionConfig = {
            listenerId: 'dev',
            seed: 1,
            selector: {mode: 'random', axis: 'fundamental', targetVoiceIndex: 1, baseline: {voices: [v0, neutralVoiceParams(400)]}, range: {min: -1, max: 1}},
        };
        const s = openCalibrationSession(store, cfg);

        // Act / Assert
        expect(() => s.nextTrial()).toThrow(ResampleExhaustedError);
    });
});

describe('recordChoice', () => {
    it('maps first/second to label via presentationOrder and writes one row', async () => {
        // Arrange
        const s = openCalibrationSession(store, sweep(1));
        const t = s.nextTrial()!;

        // Act: pick "first" -> the label at presentationOrder[0]
        await s.recordChoice(t, 'first');
        const {rows} = await store.getAllTrials();

        // Assert
        expect(rows).toHaveLength(1);
        expect(rows[0].choice).toBe(t.presentationOrder[0]);
        expect(rows[0].sessionId).toBe(s.sessionId);
        expect(rows[0].isSanityTrial).toBe(false);
    });

    it('writes choice tie for a tie pick', async () => {
        // Arrange / Act
        const s = openCalibrationSession(store, sweep(1));
        const t = s.nextTrial()!;
        await s.recordChoice(t, 'tie');
        const {rows} = await store.getAllTrials();

        // Assert
        expect(rows[0].choice).toBe('tie');
    });

    it('is replay-permissive: re-submitting a pending writes a second row with a fresh trialId', async () => {
        // Arrange / Act
        const s = openCalibrationSession(store, sweep(1));
        const t = s.nextTrial()!;
        await s.recordChoice(t, 'first');
        await s.recordChoice(t, 'second');
        const {rows} = await store.getAllTrials();

        // Assert
        expect(rows).toHaveLength(2);
        expect(rows[0].trialId).not.toBe(rows[1].trialId);
    });

    it('rejects with the store error unchanged when the write fails', async () => {
        // Arrange: a store stub whose addTrial rejects.
        const failing = {
            ...store,
            addTrial: () => Promise.reject(new Error('boom')),
        } as unknown as CalibrationStore;
        const s = openCalibrationSession(failing, sweep(1));
        const t = s.nextTrial()!;

        // Act / Assert
        await expect(s.recordChoice(t, 'first')).rejects.toThrow('boom');
    });
});
