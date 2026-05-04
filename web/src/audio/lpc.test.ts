import {describe, expect, it} from 'vitest';

import {LpcAutocorrelation, LpcBurg} from './lpc';

// Helper: synthesize the impulse response of an all-pole filter
// 1 / A(z) where A(z) = 1 + a[1]*z^-1 + ... + a[p]*z^-p, driven by a
// unit impulse at n=0. The output is the inverse-z-transform of
// 1/A(z); fitting LPC to it should recover the original a[1..p].
function synthesizeAllPoleResponse(coeffs: number[], length: number): Float32Array {
    const p = coeffs.length;
    const out = new Float32Array(length);
    for (let n = 0; n < length; n++) {
        let acc = n === 0 ? 1 : 0;
        for (let j = 1; j <= p; j++) {
            if (n - j >= 0) {
                acc -= coeffs[j - 1] * out[n - j];
            }
        }
        out[n] = acc;
    }

    return out;
}

// Hamming window in place over the buffer. Used by autocorrelation
// LPC tests because the autocorrelation method needs a windowed input
// to suppress edge artefacts.
function applyHamming(buf: Float32Array): void {
    const N = buf.length;
    for (let n = 0; n < N; n++) {
        buf[n] *= 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (N - 1));
    }
}

describe('LpcAutocorrelation', () => {
    it('recovers the coefficients of an all-pole synth signal', () => {
        // Arrange: build a known 2-pole filter with a resonance around f0/fs ~= 0.1
        // (so peak at ~10% of sample rate). Pole at r * exp(j * theta) where
        // r = 0.95, theta = 2*pi*0.1. Conjugate-pair denominator:
        // (1 - r e^{j theta} z^-1)(1 - r e^{-j theta} z^-1)
        // = 1 - 2*r*cos(theta) z^-1 + r^2 z^-2
        const r = 0.95;
        const theta = 2 * Math.PI * 0.1;
        const a1 = -2 * r * Math.cos(theta);
        const a2 = r * r;
        const coeffs = [a1, a2];

        const samples = synthesizeAllPoleResponse(coeffs, 512);
        applyHamming(samples);

        // Act
        const lpc = new LpcAutocorrelation(2);
        lpc.compute(samples);

        // Assert
        expect(lpc.coefficients[0]).toBeCloseTo(1, 5);
        expect(lpc.coefficients[1]).toBeCloseTo(a1, 1);
        expect(lpc.coefficients[2]).toBeCloseTo(a2, 1);
        expect(lpc.error).toBeGreaterThan(0);
    });

    it('produces order+1 coefficients with leading 1', () => {
        // Arrange
        const samples = new Float32Array(512);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = Math.sin(2 * Math.PI * 0.1 * i) + 0.1 * Math.random();
        }
        applyHamming(samples);

        // Act
        const lpc = new LpcAutocorrelation(10);
        lpc.compute(samples);

        // Assert
        expect(lpc.coefficients.length).toBe(11);
        expect(lpc.coefficients[0]).toBe(1);
        expect(lpc.reflections.length).toBe(10);
    });

    it('handles silent input without dividing by zero', () => {
        // Arrange
        const samples = new Float32Array(256);
        const lpc = new LpcAutocorrelation(10);

        // Act + Assert: must not throw or NaN.
        lpc.compute(samples);
        expect(lpc.coefficients[0]).toBe(1);
        for (let i = 1; i <= 10; i++) {
            expect(lpc.coefficients[i]).toBe(0);
        }
        expect(lpc.error).toBe(0);
    });
});

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
        let seed = 42;
        const rand = (): number => {
            seed = (seed * 1103515245 + 12345) >>> 0;

            return ((seed & 0x7fffffff) / 0x7fffffff) * 2 - 1;
        };
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
