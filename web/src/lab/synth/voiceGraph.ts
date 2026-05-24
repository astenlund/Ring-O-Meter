// Builds a single voice's WebAudio node graph into a BaseAudioContext and
// schedules it. Source-filter model: a PeriodicWave source (harmonic profile)
// -> parallel bandpass formant filters (F1, F2) summed -> envelope gain.
// Vibrato is a live sine LFO on the source's detune; seeded drift+jitter is a
// precomputed detune curve summed onto the same AudioParam (WebAudio sums the
// curve automation with connected inputs). Returns the output node; the caller
// connects it and calls start(t0).

import type {VoiceParams} from './voiceParams';
import {buildDetuneCents} from './variationCurve';

const F1_Q = 8;
const F2_Q = 10;
const RELEASE_TAIL_S = 0.05;

// Single-shot: start() may be called at most once (it starts WebAudio
// oscillators, which are not restartable). Re-rendering the same voice needs a
// fresh buildVoice against a new context. Vibrato phase is seed-independent
// (the LFO starts at phase 0 deterministically); only drift+jitter consume the
// seed, so (params, seed) still re-renders bit-identically.
export interface ScheduledVoice {
    output: AudioNode;
    start: (whenS: number) => void;
}

function buildPeriodicWave(ctx: BaseAudioContext, partials: number[]): PeriodicWave {
    // index 0 = DC, index 1 = fundamental, index 2.. = partials 2..8
    const len = partials.length + 2;
    const real = new Float32Array(len);
    const imag = new Float32Array(len);
    imag[1] = 1.0;
    for (let p = 0; p < partials.length; p++) {
        imag[p + 2] = partials[p];
    }
    return ctx.createPeriodicWave(real, imag, {disableNormalization: true});
}

export function buildVoice(ctx: BaseAudioContext, params: VoiceParams, seed: number, durationS: number): ScheduledVoice {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(buildPeriodicWave(ctx, params.partialAmplitudes));
    osc.frequency.value = params.fundamentalHz;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = params.vibratoRateHz;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = params.vibratoDepthCents;
    lfo.connect(lfoGain).connect(osc.detune);

    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = params.f1Hz;
    f1.Q.value = F1_Q;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = params.f2Hz;
    f2.Q.value = F2_Q;
    osc.connect(f1);
    osc.connect(f2);

    const sum = ctx.createGain();
    f1.connect(sum);
    f2.connect(sum);

    const env = ctx.createGain();
    env.gain.value = 0;
    sum.connect(env);

    return {
        output: env,
        start: (whenS: number): void => {
            const t0 = whenS + params.onsetOffsetMs / 1000;
            const audibleS = durationS - params.onsetOffsetMs / 1000;
            if (audibleS <= 0) {
                return; // onset beyond the render window: voice never sounds
            }
            // Curve spans only the audible remainder so it never overruns the
            // render (an overrun drops the tail and breaks seeded
            // reproducibility) and never passes duration 0 to
            // setValueCurveAtTime (which throws RangeError).
            const curve = buildDetuneCents(audibleS, params.driftCents, params.jitterCents, seed);
            osc.detune.setValueCurveAtTime(curve, t0, audibleS);

            const a = params.envelope.attackMs / 1000;
            const s = params.envelope.sustainMs / 1000;
            const r = params.envelope.releaseMs / 1000;
            env.gain.setValueAtTime(0, t0);
            env.gain.linearRampToValueAtTime(1, t0 + a);
            env.gain.setValueAtTime(1, t0 + a + s);
            env.gain.linearRampToValueAtTime(0, t0 + a + s + r);

            const stopAt = t0 + a + s + r + RELEASE_TAIL_S;
            osc.start(t0);
            lfo.start(t0);
            osc.stop(stopAt);
            lfo.stop(stopAt);
        },
    };
}
