import {describe, expect, it} from 'vitest';
import {neutralVoiceParams, type ChordParams} from '../synth/voiceParams';
import {centsBetween, formantCollides, partialCoincidenceFrequencies, COINCIDENCE_TOLERANCE_CENTS} from './coincidence';

function chordWith(fundamentals: number[], f1: number, f2: number): ChordParams {
    return {
        voices: fundamentals.map((hz) => ({...neutralVoiceParams(hz), f1Hz: f1, f2Hz: f2})),
    };
}

describe('centsBetween', () => {
    it('is zero for equal frequencies and symmetric', () => {
        // Arrange / Act / Assert
        expect(centsBetween(440, 440)).toBe(0);
        expect(centsBetween(440, 880)).toBeCloseTo(1200, 5);
        expect(centsBetween(880, 440)).toBeCloseTo(1200, 5);
    });
});

describe('partialCoincidenceFrequencies', () => {
    it('finds the octave coincidence between two voices an octave apart', () => {
        // Arrange: 200 Hz and 400 Hz share partials (400=200*2, 800=400*2, ...)
        const chord = chordWith([200, 400], 5000, 6000); // formants far above partials

        // Act
        const coincidences = partialCoincidenceFrequencies(chord);

        // Assert: at least the 400 Hz coincidence (voice0 partial 2 == voice1 partial 1)
        expect(coincidences.some((f) => Math.abs(f - 400) < 1)).toBe(true);
    });

    it('returns empty for a single voice (no cross-voice pairs)', () => {
        // Arrange / Act / Assert
        expect(partialCoincidenceFrequencies(chordWith([220], 600, 1200))).toHaveLength(0);
    });
});

describe('formantCollides', () => {
    it('is true when a formant center sits on a coincidence frequency', () => {
        // Arrange: octave pair coincides at 400 Hz; place a formant there.
        const chord = chordWith([200, 400], 400, 5000);

        // Act / Assert
        expect(formantCollides(chord)).toBe(true);
    });

    it('is false when formants sit between coincidences', () => {
        // Arrange: coincidences cluster on harmonics of 200; put formants in gaps.
        const chord = chordWith([200, 400], 530, 1370);

        // Act / Assert
        expect(formantCollides(chord)).toBe(false);
    });

    it('respects the tolerance argument', () => {
        // Arrange: a formant ~80 cents from the 400 Hz coincidence.
        const near = 400 * Math.pow(2, 80 / 1200);
        const chord = chordWith([200, 400], near, 5000);

        // Act / Assert: inside default 100-cent tolerance, outside a 50-cent one.
        expect(formantCollides(chord, COINCIDENCE_TOLERANCE_CENTS)).toBe(true);
        expect(formantCollides(chord, 50)).toBe(false);
    });
});
