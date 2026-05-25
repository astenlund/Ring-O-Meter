// Applies a signed axis delta (in the axis's native unit) to one voice of a
// chord, producing a new chord. Pure: clones via structuredClone, never mutates
// the input. Clamps results to physical floors post-transform (spec's
// "post-clamp" transform). The switch below is the per-axis apply authority;
// native units are documented in the spec.

import type {ChordParams, PartialAmplitudes} from '../synth/voiceParams';
import type {SweepAxis} from './protocolTypes';

const HZ_FLOOR = 1; // formant/rate/fundamental floor

export function applyAxisDelta(chord: ChordParams, axis: SweepAxis, targetVoiceIndex: number, delta: number): ChordParams {
    const next = structuredClone(chord);
    const v = next.voices[targetVoiceIndex];

    switch (axis) {
        case 'fundamental':
            v.fundamentalHz = Math.max(HZ_FLOOR, v.fundamentalHz * Math.pow(2, delta / 1200));
            break;
        case 'harmonicRichness':
            v.partialAmplitudes = v.partialAmplitudes.map((a) => Math.max(0, a * (1 + delta))) as PartialAmplitudes;
            break;
        case 'formant.f1':
            v.f1Hz = Math.max(HZ_FLOOR, v.f1Hz + delta);
            break;
        case 'formant.f2':
            v.f2Hz = Math.max(HZ_FLOOR, v.f2Hz + delta);
            break;
        case 'pitchVariance.drift':
            v.driftCents = Math.max(0, v.driftCents + delta);
            break;
        case 'pitchVariance.jitter':
            v.jitterCents = Math.max(0, v.jitterCents + delta);
            break;
        case 'vibrato.rate':
            v.vibratoRateHz = Math.max(0, v.vibratoRateHz + delta);
            break;
        case 'vibrato.depth':
            v.vibratoDepthCents = Math.max(0, v.vibratoDepthCents + delta);
            break;
        case 'envelope.attack':
            v.envelope.attackMs = Math.max(0, v.envelope.attackMs + delta);
            break;
        case 'envelope.sustain':
            v.envelope.sustainMs = Math.max(0, v.envelope.sustainMs + delta);
            break;
        case 'envelope.release':
            v.envelope.releaseMs = Math.max(0, v.envelope.releaseMs + delta);
            break;
        case 'onset':
            v.onsetOffsetMs = Math.max(0, v.onsetOffsetMs + delta);
            break;
        default: {
            const _exhaustive: never = axis;

            return _exhaustive;
        }
    }

    return next;
}
