import {nearestNote} from '../music/pitch';

// Shared "is the detector locked enough to display this voice at full
// strength" threshold. Below this confidence the readout dims and the
// plot breaks its trace; both UI surfaces must stay aligned.
export const MIN_DISPLAY_CONFIDENCE = 0.5;

export function formatNoteWithCents(hz: number): string {
    if (!(hz > 0) || !Number.isFinite(hz)) {
        return '--';
    }

    const {name, octave, cents} = nearestNote(hz);
    const rounded = Math.round(cents);
    const sign = rounded >= 0 ? '+' : '';

    return `${name}${octave} ${sign}${rounded}c`;
}
