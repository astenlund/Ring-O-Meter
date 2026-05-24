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

        // Assert: 2 s at 100 Hz = 200 samples (pinned, not recomputed via the impl formula)
        expect(curve).toHaveLength(2 * CURVE_RATE_HZ);
        expect(2 * CURVE_RATE_HZ).toBe(200);
    });

    it('floors to a 2-sample curve for sub-grid durations', () => {
        // Arrange / Act: 0.001 s rounds below 1 sample; the Math.max(2, ...) floor applies
        const curve = buildDetuneCents(0.001, 10, 5, 1);

        // Assert: no throw, minimum length 2
        expect(curve).toHaveLength(2);
    });

    it('isolates jitter from drift in the RNG draw order', () => {
        // Arrange / Act: same seed, but drift-only vs jitter-only draw/scale the
        // RNG differently, so the curves must differ; jitter-only must be non-zero.
        const driftOnly = buildDetuneCents(1, 10, 0, 5);
        const jitterOnly = buildDetuneCents(1, 0, 10, 5);

        // Assert
        expect(Array.from(jitterOnly)).not.toEqual(Array.from(driftOnly));
        expect(jitterOnly.some((x) => x !== 0)).toBe(true);
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
