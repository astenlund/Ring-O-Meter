import {describe, expect, it} from 'vitest';
import {OctaveStabilizer, TOLERANCE_CENTS} from './octaveStabilizer';

// Offsets used to probe either side of the tolerance boundary. Parameterized
// against TOLERANCE_CENTS so the tests still exercise the intended boundary
// if the heuristic is ever retuned.
const INSIDE_TOLERANCE_CENTS = TOLERANCE_CENTS - 1;
const OUTSIDE_TOLERANCE_CENTS = TOLERANCE_CENTS + 1;

describe('OctaveStabilizer', () => {
    it('accepts the first frame unchanged and flags no correction', () => {
        // Arrange
        const stabilizer = new OctaveStabilizer();

        // Act
        const result = stabilizer.apply(220);

        // Assert
        expect(result).toEqual({hz: 220, corrected: false});
    });

    it('passes small variations through without correcting', () => {
        // Arrange
        const stabilizer = new OctaveStabilizer();
        stabilizer.apply(220);

        // Act (a perfect fifth jump is non-octave and should not be corrected)
        const result = stabilizer.apply(330);

        // Assert
        expect(result).toEqual({hz: 330, corrected: false});
    });

    it('halves a 2x jump back to the reference octave', () => {
        // Arrange
        const stabilizer = new OctaveStabilizer();
        stabilizer.apply(220);

        // Act
        const result = stabilizer.apply(440);

        // Assert
        expect(result.corrected).toBe(true);
        expect(result.hz).toBeCloseTo(220, 10);
    });

    it('doubles a 0.5x jump back to the reference octave', () => {
        // Arrange
        const stabilizer = new OctaveStabilizer();
        stabilizer.apply(440);

        // Act
        const result = stabilizer.apply(220);

        // Assert
        expect(result.corrected).toBe(true);
        expect(result.hz).toBeCloseTo(440, 10);
    });

    it('corrects 4x and 0.25x multi-octave errors', () => {
        // Arrange
        const up = new OctaveStabilizer();
        up.apply(110);
        const down = new OctaveStabilizer();
        down.apply(440);

        // Act
        const upResult = up.apply(440);
        const downResult = down.apply(110);

        // Assert
        expect(upResult.corrected).toBe(true);
        expect(upResult.hz).toBeCloseTo(110, 10);
        expect(downResult.corrected).toBe(true);
        expect(downResult.hz).toBeCloseTo(440, 10);
    });

    it('accepts a near-octave jump just inside the tolerance', () => {
        // Arrange
        const stabilizer = new OctaveStabilizer();
        stabilizer.apply(220);
        // Flat of 2x (YIN latching onto a slightly detuned second harmonic),
        // still inside the tolerance.
        const nearOctave = 220 * 2 * 2 ** (-INSIDE_TOLERANCE_CENTS / 1200);

        // Act
        const result = stabilizer.apply(nearOctave);

        // Assert
        expect(result.corrected).toBe(true);
        expect(result.hz).toBeCloseTo(220 * 2 ** (-INSIDE_TOLERANCE_CENTS / 1200), 6);
    });

    it('leaves a near-octave jump just outside the tolerance uncorrected', () => {
        // Arrange
        const stabilizer = new OctaveStabilizer();
        stabilizer.apply(220);
        // Sharp of 2x, just past the tolerance - treated as a real (non-octave)
        // pitch move rather than a YIN octave error.
        const offOctave = 220 * 2 * 2 ** (OUTSIDE_TOLERANCE_CENTS / 1200);

        // Act
        const result = stabilizer.apply(offOctave);

        // Assert
        expect(result.corrected).toBe(false);
        expect(result.hz).toBe(offOctave);
    });

    it('adopts the corrected value as the new reference', () => {
        // Arrange
        const stabilizer = new OctaveStabilizer();
        stabilizer.apply(220);
        stabilizer.apply(440); // corrected back to 220

        // Act (234 Hz relative to a new reference of 220 is ~110 cents sharp,
        // not an octave - must pass through unchanged, proving the reference
        // is the corrected 220 and not the raw 440)
        const result = stabilizer.apply(234);

        // Assert
        expect(result.corrected).toBe(false);
        expect(result.hz).toBe(234);
    });

    it('passes zero and non-finite hz through without touching state', () => {
        // Arrange
        const stabilizer = new OctaveStabilizer();
        stabilizer.apply(220);

        // Act
        const zeroResult = stabilizer.apply(0);
        const nanResult = stabilizer.apply(Number.NaN);
        const infResult = stabilizer.apply(Number.POSITIVE_INFINITY);
        const negativeResult = stabilizer.apply(-100);
        // State must still be 220: a subsequent 440 should still be corrected.
        const followUp = stabilizer.apply(440);

        // Assert
        expect(zeroResult).toEqual({hz: 0, corrected: false});
        expect(nanResult.corrected).toBe(false);
        expect(Number.isNaN(nanResult.hz)).toBe(true);
        expect(infResult.hz).toBe(Number.POSITIVE_INFINITY);
        expect(infResult.corrected).toBe(false);
        expect(negativeResult).toEqual({hz: -100, corrected: false});
        expect(followUp.corrected).toBe(true);
        expect(followUp.hz).toBeCloseTo(220, 10);
    });

    it('seeds state from the first positive finite hz, ignoring earlier garbage', () => {
        // Arrange
        const stabilizer = new OctaveStabilizer();

        // Act
        stabilizer.apply(0);
        stabilizer.apply(Number.NaN);
        const seed = stabilizer.apply(300);
        const followUp = stabilizer.apply(600);

        // Assert
        expect(seed).toEqual({hz: 300, corrected: false});
        expect(followUp.corrected).toBe(true);
        expect(followUp.hz).toBeCloseTo(300, 10);
    });
});
