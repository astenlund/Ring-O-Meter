import {describe, expect, it} from 'vitest';
import {octaveReducedCents} from './octaveCents';

describe('octaveReducedCents', () => {
    it('returns 0 for unison (same Hz)', () => {
        expect(octaveReducedCents(440, 440)).toBeCloseTo(0, 5);
    });

    it('returns 0 for octave doubling (collapsed)', () => {
        expect(octaveReducedCents(880, 440)).toBeCloseTo(0, 5);
    });

    it('returns ~702 for perfect fifth (3:2)', () => {
        expect(octaveReducedCents(660, 440)).toBeCloseTo(701.96, 1);
    });

    it('handles voice below root (negative log), normalises to [0,1200)', () => {
        // 220 Hz vs root 440 Hz: log2(220/440) = -1, expect 0 (octave below = same pitch class)
        expect(octaveReducedCents(220, 440)).toBeCloseTo(0, 5);
        // 293.33 Hz vs root 440 Hz: log2(0.667) = -0.585; cents = -702 → +498 mod 1200 = 498
        expect(octaveReducedCents(440 / 1.5, 440)).toBeCloseTo(498.04, 1);
    });
});
