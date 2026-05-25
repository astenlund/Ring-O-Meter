import {describe, expect, it} from 'vitest';
import {neutralVoiceParams, type ChordParams} from '../synth/voiceParams';
import {applyAxisDelta} from './axisTransform';

function chord(): ChordParams {
    return {voices: [neutralVoiceParams(220), neutralVoiceParams(330)]};
}

describe('applyAxisDelta', () => {
    it('does not mutate the input chord', () => {
        // Arrange
        const c = chord();
        const before = c.voices[0].f1Hz;

        // Act
        applyAxisDelta(c, 'formant.f1', 0, 50);

        // Assert
        expect(c.voices[0].f1Hz).toBe(before);
    });

    it('applies a multiplicative cents shift to the fundamental', () => {
        // Arrange / Act: +1200 cents = one octave up
        const next = applyAxisDelta(chord(), 'fundamental', 1, 1200);

        // Assert
        expect(next.voices[1].fundamentalHz).toBeCloseTo(660, 5);
        expect(next.voices[0].fundamentalHz).toBe(220); // other voice untouched
    });

    it('applies an additive Hz shift to a formant on the target voice only', () => {
        // Arrange / Act
        const next = applyAxisDelta(chord(), 'formant.f2', 0, 100);

        // Assert
        expect(next.voices[0].f2Hz).toBe(1300);
        expect(next.voices[1].f2Hz).toBe(1200);
    });

    it('scales partials 2-8 for harmonicRichness and clamps at zero', () => {
        // Arrange / Act
        const up = applyAxisDelta(chord(), 'harmonicRichness', 0, 1); // x2
        const floored = applyAxisDelta(chord(), 'harmonicRichness', 0, -5); // clamps to 0

        // Assert
        expect(up.voices[0].partialAmplitudes[0]).toBeCloseTo(1.0, 5); // 0.5 * 2
        expect(floored.voices[0].partialAmplitudes.every((a) => a === 0)).toBe(true);
    });

    it('clamps additive Hz/ms results at their physical floor', () => {
        // Arrange / Act: drive a formant far negative
        const next = applyAxisDelta(chord(), 'formant.f1', 0, -10000);

        // Assert
        expect(next.voices[0].f1Hz).toBeGreaterThan(0);
    });
});
