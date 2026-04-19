import {describe, expect, it} from 'vitest';
import {nearestNote} from '../music/pitch';

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
