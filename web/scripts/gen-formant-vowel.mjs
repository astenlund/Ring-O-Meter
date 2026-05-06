// Emits web/test-fixtures/vowel-with-formants.wav: 90 s, 48 kHz,
// 16-bit mono PCM. Same harmonic source as gen-test-audio.mjs (220 Hz
// fundamental + 6 monotonically decreasing harmonics, 5.5 Hz / 15
// cents vibrato), then cascaded through 4 conjugate-pair two-pole
// IIR resonators at /a/-vowel formants with Praat-realistic
// bandwidths. Unlike sustained-vowel.wav (whose spectrum is just the
// raw harmonics with no vocal-tract filter), this fixture has known
// ground-truth F1..F4 that an LPC formant detector can be evaluated
// against.
//
// Used by formant-pipeline validation work; not currently consumed
// by the e2e smoothness suite (which uses sustained-vowel.wav for
// rendering-load testing where the raw harmonics are sufficient).
//
// Formant choice: /a/ at F1=750, F2=1100, F3=2500, F4=3500 Hz.
// Open vowel with widely-spaced low formants - high F1 vs the
// closer /i/ family makes the F1-F2 separation easy to see.
// Bandwidths follow Praat's defaults (narrow at low freq, wider
// up high) so the resonances are realistic but unambiguously
// detectable. The IIR cascade is driven by the harmonic source
// (not white noise) so YIN still has a clean fundamental to track:
// pitch-detection tests can use this fixture too.
//
// Filter formula: 2-pole IIR per formant, pole at
//   r = exp(-pi * bw / fs)
//   theta = 2 * pi * f / fs
// y[n] = x[n] + 2*r*cos(theta)*y[n-1] - r*r*y[n-2]
// (sign flipped vs. the testSignal.ts in-process variant: that one
// stores `a1 = -2*r*cos(theta)` and subtracts; equivalent algebra,
// just inlined here so this script has no .ts dependency).
import {WAV_HEADER_BYTES, writeWavFile, writeWavHeader} from './wav-utils.mjs';

const SAMPLE_RATE = 48_000;
const DURATION_S = 90;
const FUNDAMENTAL_HZ = 220;
const VIBRATO_HZ = 5.5;
const VIBRATO_CENTS = 15;
const HARMONIC_AMPS = [1.0, 0.5, 0.3, 0.2, 0.12, 0.08];
// /a/-vowel formants (Hz) and bandwidths (Hz). F1..F4 are the
// ground truth for any formant detector evaluated against this
// fixture; bandwidths are Praat defaults shaped for this F-set.
const FORMANTS = [
    {f: 750, bw: 80},
    {f: 1100, bw: 100},
    {f: 2500, bw: 120},
    {f: 3500, bw: 150},
];
// Peak-normalisation target: 0.7 leaves headroom against any
// downstream gain stage (matches the in-process synthesizeVowel
// helper). Distinct from the unfiltered fixture's `gain = 0.35`
// because IIR resonances amplify near formant frequencies, so
// we normalise post-filter rather than apply a static gain.
const NORM_PEAK = 0.7;

const totalSamples = SAMPLE_RATE * DURATION_S;
let samples = new Float32Array(totalSamples);

// Source: same harmonic stack + vibrato as gen-test-audio.mjs.
let phaseFund = 0;
const twoPi = Math.PI * 2;
for (let i = 0; i < totalSamples; i += 1) {
    const t = i / SAMPLE_RATE;
    const cents = Math.sin(twoPi * VIBRATO_HZ * t) * VIBRATO_CENTS;
    const freq = FUNDAMENTAL_HZ * Math.pow(2, cents / 1200);
    phaseFund += (twoPi * freq) / SAMPLE_RATE;
    let sample = 0;
    for (let h = 0; h < HARMONIC_AMPS.length; h += 1) {
        sample += HARMONIC_AMPS[h] * Math.sin(phaseFund * (h + 1));
    }
    samples[i] = sample;
}

// Vocal-tract filter: 4 cascaded 2-pole IIR resonators. Each
// formant gets its own pass over the buffer. Coefficients are
// stable for r < 1 (always true while bw > 0), so no need to
// guard against blow-up.
for (const formant of FORMANTS) {
    const r = Math.exp(-Math.PI * formant.bw / SAMPLE_RATE);
    const theta = 2 * Math.PI * formant.f / SAMPLE_RATE;
    const c1 = 2 * r * Math.cos(theta);
    const c2 = r * r;
    const out = new Float32Array(totalSamples);
    let yPrev = 0;
    let yPrevPrev = 0;
    for (let n = 0; n < totalSamples; n += 1) {
        const y = samples[n] + c1 * yPrev - c2 * yPrevPrev;
        out[n] = y;
        yPrevPrev = yPrev;
        yPrev = y;
    }
    samples = out;
}

// Peak-normalise to NORM_PEAK so the cascaded resonance gain
// doesn't push samples outside [-1, 1].
let peak = 0;
for (let i = 0; i < totalSamples; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) {
        peak = a;
    }
}
if (peak > 0) {
    const scale = NORM_PEAK / peak;
    for (let i = 0; i < totalSamples; i += 1) {
        samples[i] *= scale;
    }
}

// Quantise to 16-bit PCM.
const pcm = new Int16Array(totalSamples);
for (let i = 0; i < totalSamples; i += 1) {
    const clipped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = Math.round(clipped * 32767);
}

const dataBytes = pcm.byteLength;
const buffer = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);
writeWavHeader(buffer, dataBytes, SAMPLE_RATE, 1, 16);
Buffer.from(pcm.buffer).copy(buffer, WAV_HEADER_BYTES);
writeWavFile('vowel-with-formants.wav', buffer, DURATION_S);
