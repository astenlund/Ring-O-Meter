import {describe, expect, it} from 'vitest';
import {buildDetuneCents, CURVE_RATE_HZ} from './variationCurve';

describe('buildDetuneCents', () => {
    it('is deterministic for a given seed', () => {
        // Arrange / Act
        const a = buildDetuneCents(2, 20, 5, 42);
        const b = buildDetuneCents(2, 20, 5, 42);

        // Assert
        expect(Array.from(a)).toEqual(Array.from(b));
    });

    it('samples at CURVE_RATE_HZ over the duration', () => {
        // Arrange / Act
        const curve = buildDetuneCents(2, 20, 5, 1);

        // Assert
        expect(curve).toHaveLength(Math.round(2 * CURVE_RATE_HZ));
    });

    it('is all zeros when drift and jitter are zero', () => {
        // Arrange / Act
        const curve = buildDetuneCents(1, 0, 0, 7);

        // Assert
        expect(curve.every((x) => x === 0)).toBe(true);
    });

    it('stays within +/- (drift + jitter) cents', () => {
        // Arrange
        const driftCents = 15;
        const jitterCents = 8;

        // Act
        const curve = buildDetuneCents(3, driftCents, jitterCents, 123);

        // Assert
        const bound = driftCents + jitterCents + 1e-6;
        expect(curve.every((x) => Math.abs(x) <= bound)).toBe(true);
    });
});
