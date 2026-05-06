import {describe, expect, it} from 'vitest';

import {PRE_EMPHASIS_ALPHA, PreEmphasis} from './preEmphasis';

describe('PreEmphasis', () => {
    it('applies y[n] = x[n] - alpha * x[n-1]', () => {
        // Arrange
        const filter = new PreEmphasis();
        const input = new Float32Array([1, 2, 3, 4]);
        const output = new Float32Array(4);

        // Act
        filter.apply(input, output);

        // Assert
        // First sample: x[0] - alpha * 0 = 1
        // Second: 2 - 0.97 * 1 = 1.03
        // Third: 3 - 0.97 * 2 = 1.06
        // Fourth: 4 - 0.97 * 3 = 1.09
        expect(output[0]).toBeCloseTo(1, 5);
        expect(output[1]).toBeCloseTo(2 - PRE_EMPHASIS_ALPHA * 1, 5);
        expect(output[2]).toBeCloseTo(3 - PRE_EMPHASIS_ALPHA * 2, 5);
        expect(output[3]).toBeCloseTo(4 - PRE_EMPHASIS_ALPHA * 3, 5);
    });

    it('carries state across calls (no boundary transient)', () => {
        // Arrange
        const filter = new PreEmphasis();
        const frame1 = new Float32Array([1, 2, 3]);
        const frame2 = new Float32Array([4, 5, 6]);
        const out1 = new Float32Array(3);
        const out2 = new Float32Array(3);

        // Act
        filter.apply(frame1, out1);
        filter.apply(frame2, out2);

        // Assert
        // First sample of frame2 should use last sample of frame1 (=3) as prev,
        // not 0. Otherwise we'd get a step at the frame boundary.
        expect(out2[0]).toBeCloseTo(4 - PRE_EMPHASIS_ALPHA * 3, 5);
    });

    it('reset() clears state', () => {
        // Arrange
        const filter = new PreEmphasis();
        const frame1 = new Float32Array([1, 2, 3]);
        const frame2 = new Float32Array([4, 5, 6]);
        const out = new Float32Array(3);

        // Act
        filter.apply(frame1, out);
        filter.reset();
        filter.apply(frame2, out);

        // Assert
        // After reset, prev=0, so out[0] = 4 - 0.97 * 0 = 4
        expect(out[0]).toBeCloseTo(4, 5);
    });

    it('aliasing input/output is safe', () => {
        // Arrange
        const filter = new PreEmphasis();
        const buf = new Float32Array([1, 2, 3, 4]);
        const expected = [1, 2 - PRE_EMPHASIS_ALPHA * 1, 3 - PRE_EMPHASIS_ALPHA * 2, 4 - PRE_EMPHASIS_ALPHA * 3];

        // Act
        filter.apply(buf, buf);

        // Assert
        for (let i = 0; i < buf.length; i++) {
            expect(buf[i]).toBeCloseTo(expected[i], 5);
        }
    });

    it('matches analytic transfer function magnitude at sample frequencies', () => {
        // Arrange: feed a unit-amplitude pure sine at f, measure output
        // amplitude, compare to the analytic |H(e^jw)| = sqrt(1 - 2*alpha*cos(w) + alpha^2).
        // At f=100 Hz the gain is ~0.03 (deep cut); at f=4000 Hz it's ~0.51.
        // Use an integer number of cycles to avoid leakage.
        const sampleRate = 48000;
        const checkGainAt = (hz: number): {measured: number; analytic: number} => {
            const cycles = 50;
            const N = Math.round(cycles * sampleRate / hz);
            const input = new Float32Array(N);
            for (let i = 0; i < N; i++) {
                input[i] = Math.sin(2 * Math.PI * hz * i / sampleRate);
            }
            const output = new Float32Array(N);
            new PreEmphasis().apply(input, output);
            // Discard transient (~1 sample) and measure RMS over an
            // integer-cycle window. Input RMS = 1/sqrt(2); output RMS / input RMS = |H|.
            let sumSq = 0;
            const start = 8;
            for (let i = start; i < N; i++) {
                sumSq += output[i] * output[i];
            }
            const measured = Math.sqrt(sumSq / (N - start)) * Math.SQRT2;
            const w = 2 * Math.PI * hz / sampleRate;
            const analytic = Math.sqrt(1 - 2 * PRE_EMPHASIS_ALPHA * Math.cos(w) + PRE_EMPHASIS_ALPHA * PRE_EMPHASIS_ALPHA);

            return {measured, analytic};
        };

        // Act + Assert
        const low = checkGainAt(100);
        const high = checkGainAt(4000);
        expect(low.measured).toBeCloseTo(low.analytic, 2);
        expect(high.measured).toBeCloseTo(high.analytic, 2);
        // High-frequency boost vs low-frequency: ratio should be ~17x.
        expect(high.measured / low.measured).toBeGreaterThan(10);
    });
});
