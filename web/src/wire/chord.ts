// Mirror: src/RingOMeter.Domain/Music/ChordType.cs
// Declaration order is part of the wire-contract tie-break rule: when
// two hypotheses produce identical fit sums, the lower numeric value
// wins. Do not rename or reorder existing members.

export const ChordType = {
    Major: 0,
    DominantSeventh: 1,
    Minor: 2,
    Diminished: 3,
    MinorSeventh: 4,
} as const;
export type ChordType = (typeof ChordType)[keyof typeof ChordType];

const ratioCents = (num: number, denom: number): number =>
    1200 * Math.log2(num / denom);

export interface ChordHypothesis {
    readonly type: ChordType;
    readonly targetCents: readonly number[];
    readonly minArity: number;
}

const make = (type: ChordType, targets: readonly number[]): ChordHypothesis => ({
    type,
    targetCents: targets,
    minArity: targets.length,
});

export const CHORD_HYPOTHESES: Readonly<Record<ChordType, ChordHypothesis>> = {
    [ChordType.Major]: make(ChordType.Major,
        [0, ratioCents(5, 4), ratioCents(3, 2)]),
    [ChordType.DominantSeventh]: make(ChordType.DominantSeventh,
        [0, ratioCents(5, 4), ratioCents(3, 2), ratioCents(7, 4)]),
    [ChordType.Minor]: make(ChordType.Minor,
        [0, ratioCents(6, 5), ratioCents(3, 2)]),
    [ChordType.Diminished]: make(ChordType.Diminished,
        [0, ratioCents(6, 5), ratioCents(7, 5)]),
    [ChordType.MinorSeventh]: make(ChordType.MinorSeventh,
        [0, ratioCents(6, 5), ratioCents(3, 2), ratioCents(9, 5)]),
};

export const ALL_CHORD_TYPES: readonly ChordType[] = [
    ChordType.Major,
    ChordType.DominantSeventh,
    ChordType.Minor,
    ChordType.Diminished,
    ChordType.MinorSeventh,
];

export interface ChordIdentity {
    readonly type: ChordType;
    readonly rootChannelId: string;
    readonly rootHz: number;
}
