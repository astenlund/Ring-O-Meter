import {describe, expect, it} from 'vitest';
import {formatNoteWithCents} from './formatPitch';

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

    it('returns -- for non-finite Hz', () => {
        // Arrange / Act / Assert
        expect(formatNoteWithCents(Number.NaN)).toBe('--');
        expect(formatNoteWithCents(Number.POSITIVE_INFINITY)).toBe('--');
    });

    it('returns -- for Hz outside the displayable MIDI range', () => {
        // Arrange / Act / Assert
        expect(formatNoteWithCents(30_000)).toBe('--'); // above MIDI 127
        expect(formatNoteWithCents(1)).toBe('--');      // below MIDI 0
    });
});
