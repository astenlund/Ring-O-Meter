import {describe, expect, it} from 'vitest';

import {makeLcgRand} from '../__testing/testPrng';
import {LpcBurg} from './lpc';

describe('LpcBurg', () => {
    it('recovers the coefficients of a noise-driven AR(2) signal', () => {
        // Arrange: AR(2) excited by white noise, which is the canonical Burg
        // test case (and what speech actually looks like at the formant level
        // - a random source filtered through formant resonances). Use a fixed
        // PRNG seed so the test is deterministic.
        const r = 0.9;
        const theta = 2 * Math.PI * 0.1;
        const a1 = -2 * r * Math.cos(theta);
        const a2 = r * r;
        const N = 4096;
        const samples = new Float32Array(N);
        const rand = makeLcgRand();
        for (let n = 0; n < N; n++) {
            const drive = rand();
            const y1 = n - 1 >= 0 ? samples[n - 1] : 0;
            const y2 = n - 2 >= 0 ? samples[n - 2] : 0;
            samples[n] = drive - a1 * y1 - a2 * y2;
        }

        // Act
        const lpc = new LpcBurg(2);
        lpc.compute(samples);

        // Assert: noise-driven AR(2) is what Burg is designed for.
        expect(lpc.coefficients[0]).toBeCloseTo(1, 5);
        expect(lpc.coefficients[1]).toBeCloseTo(a1, 1);
        expect(lpc.coefficients[2]).toBeCloseTo(a2, 1);
        expect(lpc.error).toBeGreaterThan(0);
    });

    it('produces a stable filter (reflections in (-1, 1))', () => {
        // Arrange: random-ish input (sum of sines).
        const samples = new Float32Array(512);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = Math.sin(2 * Math.PI * 0.1 * i) + 0.5 * Math.sin(2 * Math.PI * 0.27 * i);
        }

        // Act
        const lpc = new LpcBurg(10);
        lpc.compute(samples);

        // Assert: Burg's defining property - all reflection coefficients
        // strictly inside (-1, 1), which guarantees the resulting LPC
        // filter has all poles inside the unit circle (stable).
        for (let i = 0; i < 10; i++) {
            expect(Math.abs(lpc.reflections[i])).toBeLessThan(1);
        }
    });

    it('handles silent input without dividing by zero', () => {
        // Arrange
        const samples = new Float32Array(256);
        const lpc = new LpcBurg(10);

        // Act + Assert
        lpc.compute(samples);
        expect(lpc.coefficients[0]).toBe(1);
        expect(lpc.error).toBe(0);
    });

    it('throws on input shorter than order + 1', () => {
        // Arrange
        const lpc = new LpcBurg(10);
        const samples = new Float32Array(5);

        // Act + Assert
        expect(() => lpc.compute(samples)).toThrow();
    });
});
