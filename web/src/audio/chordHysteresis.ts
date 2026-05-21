import type {ClassifierResult} from './chordClassifier';
import {CHORD_HYPOTHESES} from '../wire/chord';

// heuristic: hysteresis-frames
const HYSTERESIS_FRAMES = 2;

export class ChordHysteresis {
    private locked: ClassifierResult = {lockedChord: null, residualsPerVoice: new Map()};
    private candidate: ClassifierResult | null = null;
    private counter = 0;
    private prevActiveCount = 0;

    public step(
        classifierResult: ClassifierResult,
        activeCount: number,
    ): ClassifierResult {
        // 1. Locked-chord-type validity guard (immediate clear, no hysteresis).
        //    Runs unconditionally every frame so a locked dom7 clears
        //    whether the voice count drops 4→3, 5→3, 6→2, etc.
        if (this.locked.lockedChord !== null) {
            const lockedHyp = CHORD_HYPOTHESES[this.locked.lockedChord.type];
            if (lockedHyp.minArity > activeCount) {
                this.locked = {lockedChord: null, residualsPerVoice: new Map()};
                this.candidate = null;
                this.counter = 0;
            }
        }

        // 2. Candidate-counter reset on voice-count crossing N=3/N=4
        //    in either direction. Per the spec's algorithm step 4:
        //    "the candidate counter resets to 0 whenever the active-
        //    voice count crosses the N=3 / N=4 threshold (either
        //    direction)." A voice-count change in either direction is
        //    a structural change to the hypothesis set being evaluated
        //    (decrease shrinks it; increase opens dom7/m7 at N=4), so
        //    prior debounce progress is no longer relevant.
        if (voiceCountCrossedHypothesisBoundary(this.prevActiveCount, activeCount)) {
            this.candidate = null;
            this.counter = 0;
        }
        this.prevActiveCount = activeCount;

        // 3. Rule B: incoming classification matches the current lock.
        //    Revert candidate to null, update residuals on locked state.
        if (sameLockedChord(classifierResult, this.locked)) {
            this.candidate = null;
            this.counter = 0;
            // Update residuals on the locked state (residuals are
            // expected to vary continuously while chord type is stable).
            this.locked = classifierResult;

            return this.locked;
        }

        // 4. Rule A: incoming classification matches the current candidate.
        //    Increment counter; promote to locked when threshold reached.
        if (this.candidate !== null && sameLockedChord(classifierResult, this.candidate)) {
            this.candidate = classifierResult;
            this.counter++;
            if (this.counter >= HYSTERESIS_FRAMES) {
                this.locked = this.candidate;
                this.candidate = null;
                this.counter = 0;

                return this.locked;
            }

            return this.locked;
        }

        // 5. Rule C: classification matches neither locked nor candidate.
        //    Start fresh candidate with counter=1.
        this.candidate = classifierResult;
        this.counter = 1;

        return this.locked;
    }
}

// Returns true for any decrease in active-voice count. The caller uses
// this to invalidate prior debounce progress when the voice set shrinks.
// The hypothesis set in step 2 changes shape at the N=3/N=4 boundary
// (dom7 + m7 only participate at N≥4; triads only at N≥3). Crossing
// that boundary in either direction invalidates any in-flight
// candidate counter, since the new candidate is being evaluated
// against a different hypothesis set than the previous frames were.
// N≤2 has no hypotheses (short-circuits to no-chord-locked), so we
// treat N<3 and N=3 as the same regime for counter-reset purposes.
function voiceCountCrossedHypothesisBoundary(prev: number, curr: number): boolean {
    if (prev <= 3 && curr === 4) {
        return true;
    }
    if (prev === 4 && curr <= 3) {
        return true;
    }

    return false;
}

function sameLockedChord(a: ClassifierResult, b: ClassifierResult): boolean {
    if (a.lockedChord === null && b.lockedChord === null) {
        return true;
    }
    if (a.lockedChord === null || b.lockedChord === null) {
        return false;
    }

    return a.lockedChord.type === b.lockedChord.type
        && a.lockedChord.rootChannelId === b.lockedChord.rootChannelId;
}
