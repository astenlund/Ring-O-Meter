import {describe, it, expect} from 'vitest';
import {noteToHz, NOTE_OPTIONS} from './noteToHz';

describe('noteToHz', () => {
    it('returns 440 for A4', () => {
        // Arrange / Act / Assert
        expect(noteToHz('A', 4)).toBeCloseTo(440, 6);
    });

    it('returns 261.6256 for C4 (middle C)', () => {
        // Arrange / Act / Assert
        expect(noteToHz('C', 4)).toBeCloseTo(261.6256, 3);
    });

    it('one octave up doubles the frequency', () => {
        // Arrange / Act / Assert
        expect(noteToHz('A', 5)).toBeCloseTo(880, 6);
    });

    it('handles sharps (A#4 = 466.16)', () => {
        // Arrange / Act / Assert
        expect(noteToHz('A#', 4)).toBeCloseTo(466.1638, 3);
    });

    it('exposes a non-empty option list for the dropdown', () => {
        // Arrange / Act / Assert
        expect(NOTE_OPTIONS.length).toBeGreaterThan(0);
        expect(NOTE_OPTIONS[0]).toHaveProperty('label');
        expect(NOTE_OPTIONS[0]).toHaveProperty('hz');
    });

    it('throws on an unknown note name', () => {
        // Arrange / Act / Assert
        expect(() => noteToHz('H', 4)).toThrow();
    });
});
