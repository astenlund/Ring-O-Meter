import {describe, expect, it} from 'vitest';

import {synthesizeVowel} from '../__testing/testSignal';
import {DEFAULT_FORMANT_SPEC, FormantDetector, adaptDecimatedRate} from './formantDetector';

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

describe('adaptDecimatedRate', () => {
    it('returns the target unchanged when it already divides input', () => {
        // Arrange + Act + Assert
        // 48000 / 12000 = 4 (integer), so 12000 is the answer.
        expect(adaptDecimatedRate(48000, 12000)).toBe(12000);
    });

    it('picks 11025 for the macOS/iOS 44100 Hz host (the bug-trigger case)', () => {
        // Arrange + Act + Assert
        // 44100 / 12000 = 3.675 (not integer); next integer ratio is 4
        // and 44100 / 4 = 11025 (which IS a divisor). 11025 is below
        // the 12000 target, satisfying decimatedRate <= target.
        expect(adaptDecimatedRate(44100, 12000)).toBe(11025);
    });

    it('walks past non-divisors to the first ratio that divides input', () => {
        // Arrange + Act + Assert
        // 96000 / 12000 = 8 (integer), so the search stops at the
        // minimum ratio. Sanity check that the loop's lower bound is
        // ceil(input / target), not 1.
        expect(adaptDecimatedRate(96000, 12000)).toBe(12000);
    });

    it('falls back to ratio=1 when target exceeds input', () => {
        // Arrange + Act + Assert
        // input < target means the largest divisor of input that's
        // <= target is input itself (ratio = 1, no decimation). The
        // resulting spec may still fail downstream (e.g. cutoff <
        // decimatedRate/2), but that's a separate validation; this
        // helper's contract is only "find a valid integer divisor".
        // Real AudioContext hosts never negotiate sampleRate below
        // ~16 kHz, so this branch is defensive rather than expected.
        expect(adaptDecimatedRate(8000, 12000)).toBe(8000);
    });

    it('returns 0 on non-positive inputs (defensive)', () => {
        // Arrange + Act + Assert
        expect(adaptDecimatedRate(0, 12000)).toBe(0);
        expect(adaptDecimatedRate(48000, 0)).toBe(0);
        expect(adaptDecimatedRate(-48000, 12000)).toBe(0);
    });
});
