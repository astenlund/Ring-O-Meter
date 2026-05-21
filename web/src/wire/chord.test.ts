import {describe, expect, it} from 'vitest';
import {CHORD_HYPOTHESES, ChordType} from './chord';

describe('CHORD_HYPOTHESES', () => {
    it('has 5 entries matching ChordType enum', () => {
        expect(Object.keys(CHORD_HYPOTHESES)).toHaveLength(5);
    });

    it('major chord has 3 chord tones at correct JI cents', () => {
        const hyp = CHORD_HYPOTHESES[ChordType.Major];
        expect(hyp.targetCents).toHaveLength(3);
        expect(hyp.targetCents[0]).toBe(0);
        expect(hyp.targetCents[1]).toBeCloseTo(386.31, 1);
        expect(hyp.targetCents[2]).toBeCloseTo(701.96, 1);
    });

    it('dom7 includes 7:4 seventh at ~969 cents', () => {
        const hyp = CHORD_HYPOTHESES[ChordType.DominantSeventh];
        expect(hyp.targetCents[3]).toBeCloseTo(968.83, 1);
    });

    it('minor7 uses 9:5 seventh', () => {
        const hyp = CHORD_HYPOTHESES[ChordType.MinorSeventh];
        expect(hyp.targetCents[3]).toBeCloseTo(1017.60, 1);
    });

    it('minArity equals chord-tone count', () => {
        expect(CHORD_HYPOTHESES[ChordType.Major].minArity).toBe(3);
        expect(CHORD_HYPOTHESES[ChordType.DominantSeventh].minArity).toBe(4);
    });
});
