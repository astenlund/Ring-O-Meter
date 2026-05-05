import {describe, expect, it} from 'vitest';

import {DEFAULT_FORMANT_SPEC, FormantDetector} from './formantDetector';

// Helper: synthesize a vowel-like signal as random source filtered
// through 4 conjugate-pair formants at known F1..F4. Returns enough
// samples for the detector to ramp up.
function synthesizeVowel(
    sampleRate: number,
    formants: {f: number; bw: number}[],
    durationSec: number,
): Float32Array {
    const N = Math.floor(sampleRate * durationSec);
    let samples = new Float32Array(N);
    let seed = 42;
    const rand = (): number => {
        seed = (seed * 1103515245 + 12345) >>> 0;

        return ((seed & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    };
    for (let i = 0; i < N; i++) {
        samples[i] = rand();
    }
    // Apply each formant as a 2-pole IIR filter at frequency f, bandwidth bw.
    // Pole at r = exp(-pi * bw / fs), angle = 2 * pi * f / fs.
    for (const formant of formants) {
        const r = Math.exp(-Math.PI * formant.bw / sampleRate);
        const theta = 2 * Math.PI * formant.f / sampleRate;
        const a1 = -2 * r * Math.cos(theta);
        const a2 = r * r;
        const out = new Float32Array(N);
        for (let n = 0; n < N; n++) {
            const x = samples[n];
            const y1 = n - 1 >= 0 ? out[n - 1] : 0;
            const y2 = n - 2 >= 0 ? out[n - 2] : 0;
            out[n] = x - a1 * y1 - a2 * y2;
        }
        samples = out;
    }
    // Normalize to max magnitude 0.7 so we don't clip downstream.
    let maxAbs = 0;
    for (let i = 0; i < N; i++) {
        if (Math.abs(samples[i]) > maxAbs) {
            maxAbs = Math.abs(samples[i]);
        }
    }
    if (maxAbs > 0) {
        const scale = 0.7 / maxAbs;
        for (let i = 0; i < N; i++) {
            samples[i] *= scale;
        }
    }

    return samples;
}

// Helper: process the whole signal in 1024-sample chunks (matching the
// worklet's FRAME_SIZE), record the detector's outputs across the run,
// return the median formant frequencies (median is robust to startup
// transients in pre-emphasis and decimator).
function medianFormants(
    detector: FormantDetector,
    signal: Float32Array,
    formantCount: number,
    frameSize = 1024,
): number[] {
    const allReadings: number[][] = Array.from({length: formantCount}, () => []);
    const inputBuf = new Float32Array(frameSize);
    let pos = 0;
    // Skip the first 0.5 s of frames as warmup.
    const warmupFrames = Math.ceil(0.5 * 48000 / frameSize);
    let frameIdx = 0;
    while (pos + frameSize <= signal.length) {
        for (let i = 0; i < frameSize; i++) {
            inputBuf[i] = signal[pos + i];
        }
        detector.process(inputBuf);
        if (frameIdx >= warmupFrames) {
            for (let f = 0; f < formantCount; f++) {
                const v = detector.result.frequencies[f];
                if (Number.isFinite(v)) {
                    allReadings[f].push(v);
                }
            }
        }
        pos += frameSize;
        frameIdx++;
    }

    return allReadings.map((arr) => {
        if (arr.length === 0) {
            return Number.NaN;
        }
        const sorted = [...arr].sort((a, b) => a - b);

        return sorted[Math.floor(sorted.length / 2)];
    });
}

describe('FormantDetector', () => {
    it('recovers F1..F4 from a synthetic vowel at 48->12 kHz', () => {
        // Arrange
        const formants = [
            {f: 500, bw: 80},
            {f: 1500, bw: 100},
            {f: 2500, bw: 120},
            {f: 3500, bw: 150},
        ];
        const signal = synthesizeVowel(48000, formants, 1.0);
        // Spread DEFAULT_FORMANT_SPEC (rather than inlining its values)
        // so a future tuning pass tracks production automatically. The
        // override-after-spread shape is the convention; here it just
        // adds inputRate.
        const detector = new FormantDetector({
            ...DEFAULT_FORMANT_SPEC,
            inputRate: 48000,
        });

        // Act
        const medians = medianFormants(detector, signal, 4);

        // Assert
        expect(medians[0]).toBeGreaterThan(450);
        expect(medians[0]).toBeLessThan(550);
        expect(medians[1]).toBeGreaterThan(1400);
        expect(medians[1]).toBeLessThan(1600);
        expect(medians[2]).toBeGreaterThan(2400);
        expect(medians[2]).toBeLessThan(2600);
        expect(medians[3]).toBeGreaterThan(3400);
        expect(medians[3]).toBeLessThan(3600);
    });

    it('returns NaN frequencies on silent input', () => {
        // Arrange
        const silence = new Float32Array(1024);
        const detector = new FormantDetector({
            ...DEFAULT_FORMANT_SPEC,
            inputRate: 48000,
        });

        // Act: prime decimator with a few frames of silence.
        for (let i = 0; i < 10; i++) {
            detector.process(silence);
        }

        // Assert: with zero energy in, LPC produces an all-zero polynomial
        // (a[0]=1, others 0), whose only roots are at 0 (real). So no
        // complex formant candidates - all NaN.
        for (let i = 0; i < 4; i++) {
            expect(Number.isNaN(detector.result.frequencies[i])).toBe(true);
            expect(Number.isNaN(detector.result.bandwidths[i])).toBe(true);
        }
    });

    it('rejects unsupported decimation factor at construction', () => {
        // Arrange + Act + Assert
        expect(() => new FormantDetector({
            inputRate: 48000,
            decimatedRate: 7000,
            decimatorCutoffHz: 3000,
            lpcOrder: 10,
            formantCount: 2,
        })).toThrow();
    });

    it('rejects formantCount above lpcOrder/2 at construction', () => {
        // Arrange + Act + Assert: at lpcOrder=4, max possible formants
        // is floor(4/2)=2, so formantCount=3 must throw. Guards against
        // permanently-NaN trailing slots reaching the gating + paint
        // path with no upstream warning.
        expect(() => new FormantDetector({
            inputRate: 48000,
            decimatedRate: 12000,
            decimatorCutoffHz: 5500,
            lpcOrder: 4,
            formantCount: 3,
        })).toThrow(/formantCount 3 exceeds the 2 max/);
    });
});
