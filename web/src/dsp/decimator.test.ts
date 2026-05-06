import {describe, expect, it} from 'vitest';

import {Decimator} from './decimator';

describe('Decimator', () => {
    it('rejects non-integer decimation factor', () => {
        // Arrange + Act + Assert
        expect(() => new Decimator({inputRate: 48000, outputRate: 7000, cutoffHz: 3000})).toThrow();
    });

    it('passes DC unchanged', () => {
        // Arrange
        const dec = new Decimator({inputRate: 48000, outputRate: 8000, cutoffHz: 3500});
        const input = new Float32Array(1024);
        input.fill(0.5);
        const output = new Float32Array(256);

        // Act: prime the filter with one frame so the delay line is full of 0.5,
        // then measure on a second frame.
        dec.process(input, output);
        const written = dec.process(input, output);

        // Assert: 2 * 1024 inputs at factor 6 = 341 outputs total, distributed
        // 170 + 171 across the two calls (the carry from the first call advances
        // the second by one). Either ordering depending on framing offsets;
        // both 170 and 171 are correct.
        expect(written === 170 || written === 171).toBe(true);
        // DC gain of normalized FIR is 1; output is sample-rate-converted but
        // amplitude-preserved.
        for (let i = 0; i < written; i++) {
            expect(output[i]).toBeCloseTo(0.5, 4);
        }
    });

    it('attenuates frequencies above cutoff (anti-alias rejection)', () => {
        // Arrange: 48 kHz -> 8 kHz, cutoff 3500. Feed a 6 kHz sine which is
        // well above the cutoff; the FIR should attenuate it heavily so the
        // 8 kHz output (Nyquist 4 kHz) does not contain meaningful 6 kHz alias
        // (which would fold to 2 kHz).
        const sampleRate = 48000;
        const N = 4096; // long input so we can measure RMS reliably
        const input = new Float32Array(N);
        const signalHz = 6000;
        for (let i = 0; i < N; i++) {
            input[i] = Math.sin(2 * Math.PI * signalHz * i / sampleRate);
        }
        const dec = new Decimator({inputRate: 48000, outputRate: 8000, cutoffHz: 3500});
        const output = new Float32Array(N / 6 + 1);

        // Act
        const written = dec.process(input, output);

        // Assert: input RMS = 1/sqrt(2) ~= 0.707. Output RMS should be
        // attenuated by the filter; alias would land at 8000 - 6000 = 2000 Hz
        // but only after rejection. Allow generous margin: -25 dB
        // (input RMS 0.707 -> output RMS < 0.04).
        const startSample = 64; // skip transient through the filter
        let sumSq = 0;
        for (let i = startSample; i < written; i++) {
            sumSq += output[i] * output[i];
        }
        const rms = Math.sqrt(sumSq / (written - startSample));
        expect(rms).toBeLessThan(0.04);
    });

    it('passes low frequencies through (in-band signal preserved)', () => {
        // Arrange: 48 kHz -> 8 kHz, cutoff 3500 Hz. Feed a 1 kHz sine which is
        // well below the cutoff; output should preserve amplitude (~0.707 RMS).
        const sampleRate = 48000;
        const N = 4096;
        const input = new Float32Array(N);
        const signalHz = 1000;
        for (let i = 0; i < N; i++) {
            input[i] = Math.sin(2 * Math.PI * signalHz * i / sampleRate);
        }
        const dec = new Decimator({inputRate: 48000, outputRate: 8000, cutoffHz: 3500});
        const output = new Float32Array(N / 6 + 1);

        // Act
        const written = dec.process(input, output);

        // Assert
        const startSample = 64;
        let sumSq = 0;
        for (let i = startSample; i < written; i++) {
            sumSq += output[i] * output[i];
        }
        const rms = Math.sqrt(sumSq / (written - startSample));
        expect(rms).toBeCloseTo(1 / Math.SQRT2, 1);
    });

    it('produces correct factor at 48->12 kHz', () => {
        // Arrange
        const dec = new Decimator({inputRate: 48000, outputRate: 12000, cutoffHz: 5500});
        const input = new Float32Array(1024);
        input.fill(0.5);
        const output = new Float32Array(256);

        // Act
        dec.process(input, output); // prime
        const written = dec.process(input, output);

        // Assert
        expect(dec.decimationFactor).toBe(4);
        expect(written).toBe(256);
    });

    it('continues filtering across frame boundaries (no boundary spike)', () => {
        // Arrange: feed a long sine in two halves. Output of the second half
        // should be statistically identical to the equivalent slice of a
        // continuous run.
        const sampleRate = 48000;
        const N = 8192;
        const input = new Float32Array(N);
        for (let i = 0; i < N; i++) {
            input[i] = Math.sin(2 * Math.PI * 1000 * i / sampleRate);
        }

        const dec1 = new Decimator({inputRate: 48000, outputRate: 8000, cutoffHz: 3500});
        const out1 = new Float32Array(N / 6 + 1);
        const written1 = dec1.process(input, out1);

        const dec2 = new Decimator({inputRate: 48000, outputRate: 8000, cutoffHz: 3500});
        const out2 = new Float32Array(N / 6 + 1);
        const half = N / 2;
        const w2a = dec2.process(input.subarray(0, half), out2);
        const w2b = dec2.process(input.subarray(half), out2.subarray(w2a));
        const written2 = w2a + w2b;

        // Assert
        expect(written2).toBe(written1);
        for (let i = 0; i < written1; i++) {
            // Should match exactly (same arithmetic, just split into two calls).
            expect(out2[i]).toBeCloseTo(out1[i], 5);
        }
    });
});
