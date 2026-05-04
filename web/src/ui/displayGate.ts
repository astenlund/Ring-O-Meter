// Shared visual gate for pitch display. `NoteReadout` (dim state) and
// `PitchPlot` (trace breaks) both route through `shouldDisplayPitch` so
// their gates can't drift apart. `formatPitch.formatNoteWithCents` has no
// confidence input, so it guards only on the hz-sanity portion
// independently — that's a legitimate split, not a missed consumer.

// heuristic: display-gate confidence floor - below this, the readout dims and the plot breaks its trace.
export const MIN_DISPLAY_CONFIDENCE = 0.6;

// heuristic: min-formant-rms-db - sustained-voice rms floor below which
// formants are suppressed; voiceless consonants (fricatives, breathy
// onsets) typically fall below -40 dBFS even when YIN finds a plausible
// fundamental, so this is the gate that prevents garbage formants from
// appearing on a chord during voiceless syllables. Tighten (toward -30)
// if voiceless segments still leak; loosen (toward -50) if sustained
// quiet singing gets dimmed away.
export const MIN_FORMANT_RMS_DB = -40;

export function shouldDisplayPitch(hz: number, confidence: number): boolean {
    return hz > 0 && Number.isFinite(hz) && confidence >= MIN_DISPLAY_CONFIDENCE;
}

export function shouldDisplayFormants(hz: number, confidence: number, rmsDb: number): boolean {
    return shouldDisplayPitch(hz, confidence) && rmsDb > MIN_FORMANT_RMS_DB;
}
