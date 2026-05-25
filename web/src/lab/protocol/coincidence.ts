// Partial-coincidence frequencies and the confound collision check for the
// calibration protocol. A coincidence is a frequency where partials of two or
// more voices align within tolerance; a control formant "collides" when its
// center sits within the same tolerance of a coincidence. Cents (not Hz) because
// the confound is acoustic-reinforcement overlap, whose width scales with
// frequency (spec section "### Experimental-design caution").

import type {ChordParams} from '../synth/voiceParams';

// heuristic: confound-collision tolerance
export const COINCIDENCE_TOLERANCE_CENTS = 100;

const PARTIALS = [1, 2, 3, 4, 5, 6, 7, 8];

export function centsBetween(a: number, b: number): number {
    return Math.abs(1200 * Math.log2(a / b));
}

// Frequencies where a partial of one voice aligns with a partial of another,
// within toleranceCents. Returns the geometric midpoint of each coinciding pair.
export function partialCoincidenceFrequencies(chord: ChordParams, toleranceCents = COINCIDENCE_TOLERANCE_CENTS): number[] {
    const perVoice = chord.voices.map((v) => PARTIALS.map((n) => v.fundamentalHz * n));
    const out: number[] = [];
    for (let i = 0; i < perVoice.length; i++) {
        for (let j = i + 1; j < perVoice.length; j++) {
            for (const fi of perVoice[i]) {
                for (const fj of perVoice[j]) {
                    if (centsBetween(fi, fj) <= toleranceCents) {
                        out.push(Math.sqrt(fi * fj));
                    }
                }
            }
        }
    }

    return out;
}

// True when any voice's F1 or F2 sits within toleranceCents of any coincidence.
export function formantCollides(chord: ChordParams, toleranceCents = COINCIDENCE_TOLERANCE_CENTS): boolean {
    const coincidences = partialCoincidenceFrequencies(chord, toleranceCents);
    for (const v of chord.voices) {
        for (const formant of [v.f1Hz, v.f2Hz]) {
            for (const c of coincidences) {
                if (centsBetween(formant, c) <= toleranceCents) {
                    return true;
                }
            }
        }
    }

    return false;
}
