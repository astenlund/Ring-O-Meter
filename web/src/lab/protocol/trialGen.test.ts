import {describe, expect, it} from 'vitest';
import {mulberry32} from '../synth/seededRng';
import {neutralVoiceParams, type ChordParams} from '../synth/voiceParams';
import {CalibrationConfigError, type SessionConfig} from './protocolTypes';
import {assignLabels, axisIsTuning, choosePresentationOrder, drawSeed, validateConfig} from './trialGen';

function baseline(): ChordParams {
    return {voices: [neutralVoiceParams(220), neutralVoiceParams(277)]};
}

function sweepConfig(overrides: Partial<SessionConfig['selector']> = {}): SessionConfig {
    return {
        listenerId: 'l1',
        seed: 1,
        selector: {mode: 'sweep', axis: 'pitchVariance.drift', targetVoiceIndex: 0, baseline: baseline(), deltas: [10, 20], repeats: 2, ...overrides} as SessionConfig['selector'],
    };
}

describe('validateConfig', () => {
    it('accepts a well-formed sweep config', () => {
        expect(() => validateConfig(sweepConfig())).not.toThrow();
    });

    it.each([
        ['empty deltas', {deltas: []}],
        ['zero delta', {deltas: [0, 10]}],
        ['duplicate delta', {deltas: [10, 10]}],
        ['non-finite delta', {deltas: [10, NaN]}],
        ['repeats < 1', {repeats: 0}],
        ['non-integer repeats', {repeats: 1.5}],
        ['target voice out of range', {targetVoiceIndex: 9}],
    ])('rejects %s', (_label, override) => {
        expect(() => validateConfig(sweepConfig(override))).toThrow(CalibrationConfigError);
    });

    it('rejects an unknown axis', () => {
        const cfg = sweepConfig();
        (cfg.selector as {axis: string}).axis = 'bogus';
        expect(() => validateConfig(cfg)).toThrow(CalibrationConfigError);
    });

    it('rejects a confounded tuning sweep range up front', () => {
        // Arrange: a baseline whose formant lands on a coincidence at some swept tuning.
        const v0 = {...neutralVoiceParams(200), f1Hz: 400}; // 400 = octave coincidence with voice1
        const cfg: SessionConfig = {
            listenerId: 'l1',
            seed: 1,
            selector: {mode: 'sweep', axis: 'fundamental', targetVoiceIndex: 1, baseline: {voices: [v0, neutralVoiceParams(400)]}, deltas: [0.0001], repeats: 1},
        };

        // Act / Assert
        expect(() => validateConfig(cfg)).toThrow(CalibrationConfigError);
    });

    it('rejects a random range with min >= max or a non-finite bound', () => {
        const bad: SessionConfig = {listenerId: 'l1', seed: 1, selector: {mode: 'random', axis: 'formant.f1', targetVoiceIndex: 0, baseline: baseline(), range: {min: 5, max: 5}}};
        expect(() => validateConfig(bad)).toThrow(CalibrationConfigError);
    });
});

describe('axisIsTuning', () => {
    it('is true only for fundamental', () => {
        expect(axisIsTuning('fundamental')).toBe(true);
        expect(axisIsTuning('formant.f1')).toBe(false);
    });
});

describe('assignLabels', () => {
    it('maps baseline->A, shifted->B with sweepDelta = +delta when the coin is low', () => {
        // Arrange: an rng whose first draw is < 0.5
        const rng = () => 0.1;

        // Act
        const {chordA, chordB, sweepDelta} = assignLabels(rng, 'v0' as never, 'v1' as never, 25);

        // Assert
        expect(chordA).toBe('v0');
        expect(chordB).toBe('v1');
        expect(sweepDelta).toBe(25);
    });

    it('swaps and negates sweepDelta when the coin is high', () => {
        const rng = () => 0.9;
        const {chordA, chordB, sweepDelta} = assignLabels(rng, 'v0' as never, 'v1' as never, 25);
        expect(chordA).toBe('v1');
        expect(chordB).toBe('v0');
        expect(sweepDelta).toBe(-25);
    });
});

describe('choosePresentationOrder / drawSeed', () => {
    it('returns a valid order and a uint32 seed', () => {
        const rng = mulberry32(7);
        expect([['A', 'B'].join(), ['B', 'A'].join()]).toContain(choosePresentationOrder(rng).join());
        const s = drawSeed(rng);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(2 ** 32);
    });
});
