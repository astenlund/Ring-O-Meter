// web/src/lab/synth/chordBuilder.ts
// Builds a just-intonation chord for the calibration lab: each chord tone becomes
// one voice at its JI ratio off the root, carrying the chosen vowel preset's
// formants + partial profile and neutral human-variance (drift/jitter/vibrato-depth/
// onset all zero) so only a later swept axis moves between A and B. JI not 12-TET
// because ring is a JI phenomenon and the shipped confound check computes
// partial-coincidence at the trial's tuning (spec section "### Engine helper").

import {neutralVoiceParams, type ChordParams, type PartialAmplitudes, type VoiceParams} from './voiceParams';

export type ChordQuality = 'majorTriad' | 'dom7';

// JI ratios off the root for each MVP chord quality. majorTriad = 4:5:6,
// dom7 = 4:5:6:7 (the barbershop tag chord).
const QUALITY_RATIOS: Record<ChordQuality, number[]> = {
    majorTriad: [1, 5 / 4, 3 / 2],
    dom7: [1, 5 / 4, 3 / 2, 7 / 4],
};

export function voiceCountFor(quality: ChordQuality): number {
    return QUALITY_RATIOS[quality].length;
}

export interface VowelPreset {
    f1Hz: number;
    f2Hz: number;
    partialAmplitudes: PartialAmplitudes;
}

// Confound-safe vowel presets (spec "### Experimental-design caution"):
// `schwa` is the mitigation-(c) broadband/flat preset for pure-tuning questions
// (no strong formant peak to reinforce a coincidence); the named vowels are
// mitigation-(a) far-from-coincidence CANDIDATES whose non-collision depends on
// the chosen root + quality and is confirmed per-chord by the shipped confound
// check at Start (the Band 1 config guard), not guaranteed here.
const NEUTRAL_PARTIALS: PartialAmplitudes = [0.5, 0.33, 0.25, 0.2, 0.16, 0.14, 0.12];
const BROADBAND_PARTIALS: PartialAmplitudes = [0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3];

// One broadband mitigation-(c) preset plus two named mitigation-(a) candidates.
// Kept deliberately small: each named pair is an unverified candidate (the confound
// check validates per chord), so more entries would just be more unverified data.
// schwa f2 = 1800 sits in a gap clean of the dense dom7@220 coincidence stack (the
// default chord), so the lab is usable out of the box; ee / ah are alternative
// candidates that may collide for a given chord (the confound guard tells the
// operator), which is the experimental-design caution working as intended.
export const VOWEL_PRESETS: Record<string, VowelPreset> = {
    schwa: {f1Hz: 500, f2Hz: 1800, partialAmplitudes: BROADBAND_PARTIALS},
    ee: {f1Hz: 300, f2Hz: 2300, partialAmplitudes: NEUTRAL_PARTIALS},
    ah: {f1Hz: 700, f2Hz: 1100, partialAmplitudes: NEUTRAL_PARTIALS},
};

export function buildChord(rootHz: number, quality: ChordQuality, preset: VowelPreset): ChordParams {
    if (!Number.isFinite(rootHz) || rootHz <= 0) {
        throw new Error(`buildChord: rootHz must be a positive finite number, got ${rootHz}.`);
    }

    const ratios = QUALITY_RATIOS[quality];
    const voices: VoiceParams[] = ratios.map((ratio) => {
        const v = neutralVoiceParams(rootHz * ratio);
        v.f1Hz = preset.f1Hz;
        v.f2Hz = preset.f2Hz;
        // Fresh copy so voices never alias one preset array.
        v.partialAmplitudes = [...preset.partialAmplitudes] as PartialAmplitudes;

        return v;
    });

    return {voices};
}
