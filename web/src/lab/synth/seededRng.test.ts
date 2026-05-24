import {describe, expect, it} from 'vitest';
import {mulberry32} from './seededRng';

describe('mulberry32', () => {
    it('produces the same sequence for the same seed', () => {
        // Arrange
        const a = mulberry32(12345);
        const b = mulberry32(12345);

        // Act
        const seqA = [a(), a(), a(), a()];
        const seqB = [b(), b(), b(), b()];

        // Assert
        expect(seqA).toEqual(seqB);
    });

    it('produces different sequences for different seeds', () => {
        // Arrange
        const a = mulberry32(1);
        const b = mulberry32(2);

        // Act
        const first = a();
        const second = b();

        // Assert
        expect(first).not.toEqual(second);
    });

    it('returns values in [0, 1)', () => {
        // Arrange
        const rng = mulberry32(99);

        // Act / Assert
        for (let i = 0; i < 1000; i++) {
            const v = rng();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});
