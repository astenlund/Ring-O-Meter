const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const A4_HZ = 440;
const A4_MIDI = 69;

export interface NearestNote {
    name: string;
    octave: number;
    midi: number;
    cents: number;
}

export function nearestNote(hz: number): NearestNote {
    const midiExact = A4_MIDI + 12 * Math.log2(hz / A4_HZ);
    const midi = Math.max(0, Math.min(127, Math.round(midiExact)));
    const cents = (midiExact - midi) * 100;
    const name = NOTE_NAMES[midi % 12];
    const octave = Math.floor(midi / 12) - 1;

    return {name, octave, midi, cents};
}

export function formatNoteWithCents(hz: number): string {
    if (!(hz > 0) || !Number.isFinite(hz)) {
        return '--';
    }

    const {name, octave, cents} = nearestNote(hz);
    const rounded = Math.round(cents);
    const sign = rounded >= 0 ? '+' : '';

    return `${name}${octave} ${sign}${rounded}c`;
}
