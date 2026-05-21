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

        // 2. Candidate-counter reset on voice-count decrease.
        //    A decrease changes the hypothesis set being evaluated, so
        //    prior debounce progress is no longer relevant.
        if (voiceCountDecreased(this.prevActiveCount, activeCount)) {
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
function voiceCountDecreased(prev: number, curr: number): boolean {
    return curr < prev;
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
