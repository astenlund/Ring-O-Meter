import {nearestNote} from '../music/pitch';

export function formatNoteWithCents(hz: number): string {
    // Fast-path the common idle case (hz == 0 before audio starts) so we
    // don't throw-and-catch on every render. nearestNote throws when hz
    // maps outside MIDI [0, 127]; that rare case is absorbed below.
    if (!(hz > 0) || !Number.isFinite(hz)) {
        return '--';
    }

    try {
        const {name, octave, cents} = nearestNote(hz);
        const rounded = Math.round(cents);
        const sign = rounded >= 0 ? '+' : '';

        return `${name}${octave} ${sign}${rounded}c`;
    } catch {
        return '--';
    }
}
