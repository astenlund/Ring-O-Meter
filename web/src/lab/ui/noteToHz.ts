// Note-name -> frequency at A4 = 440 Hz (12-TET reference grid only; this is the
// note-picker convenience for entering a root, NOT a tuning target). The chord
// itself is built in just intonation off the resulting rootHz (see buildChord).

export type NoteName = 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B';

const SEMITONES: Record<NoteName, number> = {
    C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

const A4_MIDI = 69;
const A4_HZ = 440;

export function noteToHz(note: NoteName | string, octave: number): number {
    const semitone = SEMITONES[note as NoteName];
    if (semitone === undefined) {
        throw new Error(`noteToHz: unknown note name "${note}".`);
    }

    // MIDI: C-1 = 0, so midi = (octave + 1) * 12 + semitone.
    const midi = (octave + 1) * 12 + semitone;

    return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

export interface NoteOption {
    label: string;
    hz: number;
}

// A practical singing range for chord roots: C2..C5. The dropdown lists these;
// the operator can still type a raw Hz value in the config band's number input.
export const NOTE_OPTIONS: NoteOption[] = (() => {
    const names: NoteName[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const out: NoteOption[] = [];
    for (let octave = 2; octave <= 5; octave++) {
        for (const name of names) {
            out.push({label: `${name}${octave}`, hz: noteToHz(name, octave)});
        }
    }

    return out;
})();
