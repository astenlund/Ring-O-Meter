import {describe, expect, it} from 'vitest';
import {MIN_DISPLAY_CONFIDENCE, shouldDisplayPitch} from './displayGate';

describe('shouldDisplayPitch', () => {
    it('returns true for a confident, finite, positive pitch', () => {
        // Arrange / Act / Assert
        expect(shouldDisplayPitch(440, 0.9)).toBe(true);
    });

    it('includes confidence exactly at the threshold', () => {
        // Arrange / Act / Assert
        expect(shouldDisplayPitch(440, MIN_DISPLAY_CONFIDENCE)).toBe(true);
    });

    it('excludes confidence just below the threshold', () => {
        // Arrange
        const justBelow = MIN_DISPLAY_CONFIDENCE - 0.0001;

        // Act / Assert
        expect(shouldDisplayPitch(440, justBelow)).toBe(false);
    });

    it('excludes non-positive Hz', () => {
        // Arrange / Act / Assert
        expect(shouldDisplayPitch(0, 0.9)).toBe(false);
        expect(shouldDisplayPitch(-1, 0.9)).toBe(false);
    });

    it('excludes non-finite Hz', () => {
        // Arrange / Act / Assert
        expect(shouldDisplayPitch(Number.NaN, 0.9)).toBe(false);
        expect(shouldDisplayPitch(Number.POSITIVE_INFINITY, 0.9)).toBe(false);
        expect(shouldDisplayPitch(Number.NEGATIVE_INFINITY, 0.9)).toBe(false);
    });

    it('excludes NaN confidence', () => {
        // Arrange / Act / Assert
        expect(shouldDisplayPitch(440, Number.NaN)).toBe(false);
    });

    it('excludes negative confidence', () => {
        // Arrange / Act / Assert
        expect(shouldDisplayPitch(440, -0.1)).toBe(false);
    });

    it('includes confidence at the upper end of the normal range', () => {
        // Arrange / Act / Assert
        expect(shouldDisplayPitch(440, 1.0)).toBe(true);
    });

    it('includes confidence above the normal range (no upper bound by design)', () => {
        // Arrange / Act / Assert
        expect(shouldDisplayPitch(440, Number.POSITIVE_INFINITY)).toBe(true);
    });

    it('excludes hz = 0 regardless of confidence sanity', () => {
        // Arrange / Act / Assert
        expect(shouldDisplayPitch(0, Number.NaN)).toBe(false);
    });
});
