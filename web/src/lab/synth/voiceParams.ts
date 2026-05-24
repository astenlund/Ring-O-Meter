// Per-voice synthesis parameters for the lab. partialAmplitudes carries partials
// 2..8 (7 values) of the source harmonic profile (voice richness); f1Hz/f2Hz are
// the formant centers; drift/jitter/vibrato/envelope/onset are the human-variance
// dimensions. All seven dimensions ship together because clean A/B sweeps require
// every non-test dimension held at a controlled baseline (see spec § Synthesis engine).

export const PARTIAL_COUNT = 7; // partials 2..8 inclusive

// Amplitudes of partials 2..8 of the oscillator SOURCE spectrum (the
// PeriodicWave), each relative to the fundamental (index 1), which is fixed at
// 1.0. These set the source's richness BEFORE the formant bandpass filters
// further shape the audible spectrum; they are not post-filter output levels.
// Fixed-length tuple so a wrong-length array is a compile error.
export type PartialAmplitudes = [number, number, number, number, number, number, number];

export interface VoiceEnvelope {
    attackMs: number;
    sustainMs: number;
    releaseMs: number;
}

export interface VoiceParams {
    fundamentalHz: number;
    partialAmplitudes: PartialAmplitudes;
    f1Hz: number;
    f2Hz: number;
    driftCents: number; // peak slow-drift excursion
    jitterCents: number; // peak fast-jitter excursion
    vibratoRateHz: number;
    vibratoDepthCents: number;
    envelope: VoiceEnvelope;
    onsetOffsetMs: number; // delay relative to the global cue
}

export interface ChordParams {
    voices: VoiceParams[];
}

export function neutralVoiceParams(fundamentalHz: number): VoiceParams {
    return {
        fundamentalHz,
        partialAmplitudes: [0.5, 0.33, 0.25, 0.2, 0.16, 0.14, 0.12],
        f1Hz: 600,
        f2Hz: 1200,
        driftCents: 0,
        jitterCents: 0,
        vibratoRateHz: 5.5, // typical sung vibrato ~5-6 Hz; inert until depth > 0
        vibratoDepthCents: 0,
        envelope: {attackMs: 40, sustainMs: 1500, releaseMs: 200},
        onsetOffsetMs: 0,
    };
}
