// Per-channel capture-side policy: detect and correct YIN's periodic tendency
// to latch onto 2^k times the true fundamental and emit the wrong octave for
// a frame or two before recovering. An octave error is a structural failure,
// not a random outlier - when the ratio `hz / lastStableHz` is close to an
// integer power of two, dividing by that power yields the true pitch, so we
// adjust the frame instead of dropping it.
//
// Stateful per instance; not thread-safe, but each VoiceChannel owns its own
// stabilizer and both the main-thread consumer and the worklet-driven frame
// source run on the same thread at the point this is invoked.
//
// Kept deliberately consumer-agnostic: the caller (VoiceChannel) decides what
// to do with the raw value and the stabilized value. Display-gate filtering
// and smoothing are separate concerns.

// heuristic: octave-correction tolerance - how close a frame's log2-ratio to
// the last stable value must be to an integer power of two before we call it
// a YIN octave error rather than a genuine pitch move. Wider tolerance
// catches more YIN glitches but may misclassify real leaps; set by
// inspection of siren-test captures on 2026-04-20. Exported so boundary
// tests parameterize against it instead of hardcoding the neighbours.
export const TOLERANCE_CENTS = 20;

export interface StabilizerResult {
    hz: number;
    corrected: boolean;
}

export class OctaveStabilizer {
    private lastStableHz: number | null = null;

    public apply(hz: number): StabilizerResult {
        if (!(hz > 0) || !Number.isFinite(hz)) {
            return {hz, corrected: false};
        }
        if (this.lastStableHz === null) {
            this.lastStableHz = hz;

            return {hz, corrected: false};
        }

        const log2Ratio = Math.log2(hz / this.lastStableHz);
        const nearestOctave = Math.round(log2Ratio);
        if (nearestOctave !== 0) {
            const centsFromOctave = Math.abs(log2Ratio - nearestOctave) * 1200;
            if (centsFromOctave <= TOLERANCE_CENTS) {
                const correctedHz = hz / (2 ** nearestOctave);
                this.lastStableHz = correctedHz;

                return {hz: correctedHz, corrected: true};
            }
        }

        this.lastStableHz = hz;

        return {hz, corrected: false};
    }
}
