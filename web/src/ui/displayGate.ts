// Shared visual gate for pitch display. `NoteReadout` (dim state) and
// `PitchPlot` (trace breaks) both route through `shouldDisplayPitch` so
// their gates can't drift apart. `formatPitch.formatNoteWithCents` has no
// confidence input, so it guards only on the hz-sanity portion
// independently — that's a legitimate split, not a missed consumer.

// Below this confidence the readout dims and the plot breaks its trace.
export const MIN_DISPLAY_CONFIDENCE = 0.5;

export function shouldDisplayPitch(hz: number, confidence: number): boolean {
    return hz > 0 && Number.isFinite(hz) && confidence >= MIN_DISPLAY_CONFIDENCE;
}
