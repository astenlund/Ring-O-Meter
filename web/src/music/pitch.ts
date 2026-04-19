// Mirror: src/RingOMeter.Domain/Music/Pitch.cs + Note.cs. Both implement
// the same A4=440 / MIDI 69 Hz-to-note math and share two invariants
// (locked by tests on both sides): throw on non-positive/non-finite hz,
// and throw when the rounded MIDI falls outside [0, 127]. Keep semantics
// aligned when either side changes.
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
    if (!(hz > 0) || !Number.isFinite(hz)) {
        // Mirrors Pitch.NearestNote() in the C# domain, which throws when
        // Hz is non-positive. Callers guard with their own display-time
        // check (see formatNoteWithCents) before reaching here.
        throw new Error('nearestNote: hz must be a positive finite number');
    }

    const midiExact = A4_MIDI + 12 * Math.log2(hz / A4_HZ);
    const midi = Math.round(midiExact);
    if (midi < 0 || midi > 127) {
        // Clamping would silently produce cents far outside [-50, +50]
        // (e.g. hz = 30_000 reports "G9 +2300c"), so refuse instead.
        throw new Error('nearestNote: hz maps outside the MIDI range [0, 127]');
    }
    const cents = (midiExact - midi) * 100;
    const name = NOTE_NAMES[midi % 12];
    const octave = Math.floor(midi / 12) - 1;

    return {name, octave, midi, cents};
}
