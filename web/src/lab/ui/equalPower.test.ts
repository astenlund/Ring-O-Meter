import {describe, it, expect} from 'vitest';
import {equalPowerGains} from './equalPower';

describe('equalPowerGains', () => {
    it('is (1,0) at t=0 and (0,1) at t=1', () => {
        // Arrange / Act / Assert
        expect(equalPowerGains(0)).toEqual([expect.closeTo(1, 5), expect.closeTo(0, 5)]);
        expect(equalPowerGains(1)).toEqual([expect.closeTo(0, 5), expect.closeTo(1, 5)]);
    });

    it('preserves power: a^2 + b^2 === 1 across t', () => {
        // Arrange / Act / Assert
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            const [a, b] = equalPowerGains(t);
            expect(a * a + b * b).toBeCloseTo(1, 5);
        }
    });
});
