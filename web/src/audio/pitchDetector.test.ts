import {describe, expect, it} from 'vitest';
import {detectPitch} from './pitchDetector';
import {TARGET_SAMPLE_RATE_HZ} from './constants';

const sampleRate = TARGET_SAMPLE_RATE_HZ;

function sineSamples(hz: number, n: number, amplitude = 0.8): Float32Array {
    const out = new Float32Array(n);
    const w = (2 * Math.PI * hz) / sampleRate;
    for (let i = 0; i < n; i++) {
        out[i] = amplitude * Math.sin(w * i);
    }
    return out;
}

function noise(n: number, amplitude = 0.5): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = (Math.random() * 2 - 1) * amplitude;
    }
    return out;
}

function centsBetween(reference: number, measured: number): number {
    return 1200 * Math.log2(measured / reference);
}

describe('detectPitch', () => {
    it.each([110, 220, 440, 880])('detects %i Hz within 5 cents', (hz) => {
        // Arrange
        const samples = sineSamples(hz, 2048);

        // Act
        const result = detectPitch(samples, sampleRate);

        // Assert
        expect(result.fundamentalHz).toBeGreaterThan(0);
        expect(Math.abs(centsBetween(hz, result.fundamentalHz))).toBeLessThan(5);
        expect(result.confidence).toBeGreaterThan(0.7);
    });

    it('returns zero hz on white noise', () => {
        // Arrange
        const samples = noise(2048);

        // Act
        const result = detectPitch(samples, sampleRate);

        // Assert
        expect(result.fundamentalHz).toBe(0);
        expect(result.confidence).toBeLessThan(0.5);
    });

    it('returns zero hz on silence', () => {
        // Arrange
        const samples = new Float32Array(2048);

        // Act
        const result = detectPitch(samples, sampleRate);

        // Assert
        expect(result.fundamentalHz).toBe(0);
    });

    it('reuses scratch buffers safely across calls with shrinking buffer size', () => {
        // Arrange: call with a larger buffer first, then a smaller one, then
        // larger again. The hoisted module-scope scratch arrays must not
        // leak stale values that would corrupt the subsequent call.
        const large = sineSamples(440, 4096);
        const small = sineSamples(880, 1024);

        // Act / Assert: each call should produce a correct detection for
        // its own input, regardless of the order of calls.
        expect(Math.abs(centsBetween(440, detectPitch(large, sampleRate).fundamentalHz))).toBeLessThan(5);
        expect(Math.abs(centsBetween(880, detectPitch(small, sampleRate).fundamentalHz))).toBeLessThan(5);
        expect(Math.abs(centsBetween(440, detectPitch(large, sampleRate).fundamentalHz))).toBeLessThan(5);
    });
});
