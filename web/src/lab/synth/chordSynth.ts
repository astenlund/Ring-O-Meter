// Assembles N voices into one OfflineAudioContext render and returns the
// AudioBuffer for A/B playback. Each voice gets a distinct seed (seedBase + i)
// so per-voice variance is independent yet reproducible. Master gain divides by
// voice count for headroom against summed peaks. N-flexible (1..8); an empty
// voices array renders silence rather than erroring, and input validation is
// deferred to the trial-generation / UI phases. Loudness normalization across
// chords with differing voice counts (for fair A/B listening comparison) is a
// playback-phase concern, not applied here.

import type {ChordParams} from './voiceParams';
import {buildVoice} from './voiceGraph';

export async function renderChord(params: ChordParams, seedBase: number, durationS: number, sampleRate: number): Promise<AudioBuffer> {
    const frames = Math.ceil(durationS * sampleRate);
    const ctx = new OfflineAudioContext(1, frames, sampleRate);

    const master = ctx.createGain();
    master.gain.value = 1 / Math.max(1, params.voices.length);
    master.connect(ctx.destination);

    params.voices.forEach((voiceParams, i) => {
        const voice = buildVoice(ctx, voiceParams, seedBase + i, durationS);
        voice.output.connect(master);
        voice.start(0);
    });

    return ctx.startRendering();
}
