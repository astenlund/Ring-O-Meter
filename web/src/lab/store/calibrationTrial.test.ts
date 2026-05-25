import {describe, expect, it} from 'vitest';
import {neutralVoiceParams, type ChordParams} from '../synth/voiceParams';
import {
    CALIBRATION_ROW_SCHEMA_VERSION,
    PARAMS_SCHEMA_VERSION,
    makeCalibrationTrial,
    reloadChord,
    snapshotChord,
    tryNormalizeStoredTrial,
    type NewTrialInput,
} from './calibrationTrial';

function chord(): ChordParams {
    return {voices: [neutralVoiceParams(220), neutralVoiceParams(275)]};
}

function baseInput(): NewTrialInput {
    return {
        trialId: 't1',
        sessionId: 's1',
        listenerId: 'l1',
        selectorMode: 'sweep',
        sweepAxis: 'pitchVariance.drift',
        sweepDelta: 12,
        chordA: chord(),
        chordB: chord(),
        seedA: 1,
        seedB: 2,
        choice: 'A',
        timestampMs: 1000,
    };
}

describe('snapshotChord / reloadChord', () => {
    it('embeds the params schema version', () => {
        // Arrange / Act
        const snap = snapshotChord(chord());

        // Assert
        expect(snap.paramsSchemaVersion).toBe(PARAMS_SCHEMA_VERSION);
    });

    it('round-trips a chord through snapshot and reload', () => {
        // Arrange
        const original = chord();

        // Act
        const restored = reloadChord(snapshotChord(original));

        // Assert
        expect(restored).toEqual(original);
    });

    it('rejects an unknown params schema version', () => {
        // Arrange
        const snap = {paramsSchemaVersion: PARAMS_SCHEMA_VERSION + 1, chord: chord()};

        // Act / Assert
        expect(() => reloadChord(snap)).toThrow(/paramsSchemaVersion/);
    });

    it('rejects a voice with the wrong partial-amplitude length', () => {
        // Arrange
        const broken = chord();
        (broken.voices[0].partialAmplitudes as unknown as number[]).push(0.1);

        // Act / Assert
        expect(() => reloadChord(snapshotChord(broken))).toThrow(/partialAmplitudes/);
    });
});

describe('makeCalibrationTrial', () => {
    it('stamps the current row schema version', () => {
        // Arrange / Act
        const trial = makeCalibrationTrial(baseInput());

        // Assert
        expect(trial.rowSchemaVersion).toBe(CALIBRATION_ROW_SCHEMA_VERSION);
    });

    it('defaults isSanityTrial to false and wraps both chords', () => {
        // Arrange / Act
        const trial = makeCalibrationTrial(baseInput());

        // Assert
        expect(trial.isSanityTrial).toBe(false);
        expect(trial.paramsA.paramsSchemaVersion).toBe(PARAMS_SCHEMA_VERSION);
        expect(reloadChord(trial.paramsB)).toEqual(baseInput().chordB);
    });

    it('carries sweepAxis and sweepDelta verbatim', () => {
        // Arrange / Act
        const trial = makeCalibrationTrial(baseInput());

        // Assert
        expect(trial.sweepAxis).toBe('pitchVariance.drift');
        expect(trial.sweepDelta).toBe(12);
    });

    it('allows null sweepAxis and sweepDelta for random trials', () => {
        // Arrange
        const input = {...baseInput(), selectorMode: 'random' as const, sweepAxis: null, sweepDelta: null};

        // Act
        const trial = makeCalibrationTrial(input);

        // Assert
        expect(trial.sweepAxis).toBeNull();
        expect(trial.sweepDelta).toBeNull();
    });
});

describe('tryNormalizeStoredTrial', () => {
    it('defaults missing rowSchemaVersion and isSanityTrial to their historical values', () => {
        // Arrange: a record written before those columns existed
        const stored = makeCalibrationTrial(baseInput()) as unknown as Record<string, unknown>;
        delete stored.rowSchemaVersion;
        delete stored.isSanityTrial;

        // Act
        const trial = tryNormalizeStoredTrial(stored);

        // Assert
        expect(trial?.rowSchemaVersion).toBe(1);
        expect(trial?.isSanityTrial).toBe(false);
    });

    it('returns null for a row missing a required column', () => {
        // Arrange
        const stored = makeCalibrationTrial(baseInput()) as unknown as Record<string, unknown>;
        delete stored.trialId;

        // Act / Assert
        expect(tryNormalizeStoredTrial(stored)).toBeNull();
    });

    it('returns null for a row whose params snapshot is malformed', () => {
        // Arrange
        const stored = makeCalibrationTrial(baseInput()) as unknown as Record<string, unknown>;
        stored.paramsA = {paramsSchemaVersion: 999, chord: {voices: []}};

        // Act / Assert
        expect(tryNormalizeStoredTrial(stored)).toBeNull();
    });
});
