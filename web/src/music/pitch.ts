// Mirror: src/RingOMeter.Domain/Music/Pitch.cs + Note.cs. Both implement
// the same A4=440 / MIDI 69 Hz-to-note math; keep semantics aligned when
// either side changes.
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
