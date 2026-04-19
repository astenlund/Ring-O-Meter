import {describe, expect, it} from 'vitest';
import {nearestNote, formatNoteWithCents} from '../ui/formatPitch';

describe('nearestNote', () => {
    it('maps 440 Hz to A4 with ~0 cents', () => {
        // Arrange / Act
        const result = nearestNote(440);

        // Assert
        expect(result.name).toBe('A');
        expect(result.octave).toBe(4);
        expect(Math.abs(result.cents)).toBeLessThan(0.5);
    });

    it('maps 261.626 Hz to C4', () => {
        // Arrange / Act
        const result = nearestNote(261.626);

        // Assert
        expect(result.name).toBe('C');
        expect(result.octave).toBe(4);
    });

    it('reports +12 cents for slightly sharp A4', () => {
        // Arrange
        const hz = 440 * Math.pow(2, 12 / 1200);

        // Act
        const result = nearestNote(hz);

        // Assert
        expect(result.name).toBe('A');
        expect(result.cents).toBeCloseTo(12, 0);
    });
});

describe('formatNoteWithCents', () => {
    it('formats a clean note as "A4 +0c"', () => {
        // Arrange / Act
        const text = formatNoteWithCents(440);

        // Assert
        expect(text).toBe('A4 +0c');
    });

    it('formats a sharp note with sign', () => {
        // Arrange
        const hz = 440 * Math.pow(2, 12 / 1200);

        // Act
        const text = formatNoteWithCents(hz);

        // Assert
        expect(text).toBe('A4 +12c');
    });

    it('returns -- for non-positive Hz', () => {
        // Arrange / Act / Assert
        expect(formatNoteWithCents(0)).toBe('--');
        expect(formatNoteWithCents(-1)).toBe('--');
    });
});
