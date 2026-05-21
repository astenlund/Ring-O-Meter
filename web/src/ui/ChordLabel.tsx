import {nearestNote} from '../music/pitch';
import {ChordType, type ChordIdentity} from '../wire/chord';

const CHORD_SUFFIXES: Record<ChordType, string> = {
    [ChordType.Major]: '',
    [ChordType.DominantSeventh]: '7',
    [ChordType.Minor]: 'm',
    [ChordType.Diminished]: 'dim',
    [ChordType.MinorSeventh]: 'm7',
};

function chordLabel(chord: ChordIdentity): string {
    try {
        const {name} = nearestNote(chord.rootHz);

        return `${name}${CHORD_SUFFIXES[chord.type]}`;
    } catch {
        return '?';
    }
}

export interface ChordLabelProps {
    chord: ChordIdentity | null;
}

export function ChordLabel({chord}: ChordLabelProps) {
    if (chord === null) {
        return null;
    }

    return <span>{chordLabel(chord)}</span>;
}
