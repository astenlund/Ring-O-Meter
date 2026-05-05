// Synthetic speech-like signal generator for DSP tests. Mirrors the
// classical "noise-driven all-pole vocal tract" model: one PRNG noise
// source filtered through N two-pole IIR formants at known
// (frequency, bandwidth) pairs. Output is peak-normalised to 0.7 so it
// fits comfortably below clipping when fed into downstream gain stages.
//
// Used by formantDetector.test.ts. The companion vowel fixture under
// web/test-fixtures/ targets the e2e + smoothness tests; this helper is
// for in-process unit tests that need a deterministic vowel-like
// waveform without loading a WAV.

import {makeLcgRand} from './testPrng';

export interface FormantSpec {
    f: number;   // formant centre frequency in Hz
    bw: number;  // formant bandwidth in Hz
}

export function synthesizeVowel(
    sampleRate: number,
    formants: ReadonlyArray<FormantSpec>,
    durationSec: number,
    seed = 42,
): Float32Array {
    const N = Math.floor(sampleRate * durationSec);
    let samples = new Float32Array(N);
    const rand = makeLcgRand(seed);
    for (let i = 0; i < N; i++) {
        samples[i] = rand();
    }
    // Apply each formant as a 2-pole IIR filter at frequency f, bandwidth
    // bw. Pole at r = exp(-pi * bw / fs), angle = 2 * pi * f / fs.
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
