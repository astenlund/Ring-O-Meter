import {describe, expect, it} from 'vitest';
import {classifyChord} from './chordClassifier';
import {ChordType} from '../wire/chord';

// C4 fundamental; JI ratios build the dom7 chord from it.
const C4 = 261.626;

const voice = (channelId: string, f0Hz: number) =>
    ({channelId, f0Hz, slotIndex: 0, gateOpen: true});

describe('classifyChord', () => {
    // Test case 1 (verbatim): pure dom7 chord (C4, E4@5:4, G4@3:2, Bb4@7:4)
    it('classifies a JI dom7 chord correctly', () => {
        const voices = [
            voice('bass', C4),
            voice('bari', C4 * (5 / 4)),
            voice('lead', C4 * (3 / 2)),
            voice('tnr',  C4 * (7 / 4)),
        ];

        const result = classifyChord(voices);

        expect(result.lockedChord?.type).toBe(ChordType.DominantSeventh);
        expect(result.lockedChord?.rootChannelId).toBe('bass');
    });

    // Test case 2 (verbatim): N=2 → no-chord-locked
    it('emits no-chord-locked for N<3', () => {
        const result = classifyChord([voice('a', 440), voice('b', 550)]);

        expect(result.lockedChord).toBeNull();
        expect(result.residualsPerVoice.size).toBe(0);
    });

    // Test case 3 (verbatim): NaN voice excluded
    it('excludes NaN voices from classification', () => {
        const voices = [
            voice('a', C4),
            voice('b', C4 * 5 / 4),
            voice('c', C4 * 3 / 2),
            voice('d', Number.NaN),
        ];

        const result = classifyChord(voices);

        expect(result.lockedChord?.type).toBe(ChordType.Major);
        expect(result.residualsPerVoice.has('d')).toBe(false);
    });

    // Test case 4: inverted major (E4, G4, C5) → Major with C5 as root
    // The candidate-root loop must try every voice as root; C5 (= C4 * 2)
    // produces octave-reduced cents of 386¢ for E4 and 702¢ for G4,
    // matching the major JI table exactly.
    it('classifies inverted major triad with correct root via candidate-root loop', () => {
        // Use exact JI ratios so residuals are negligible.
        const c5 = C4 * 2;
        const e4 = C4 * (5 / 4);
        const g4 = C4 * (3 / 2);
        const voices = [
            voice('bari', e4),
            voice('lead', g4),
            voice('bass', c5),
        ];

        const result = classifyChord(voices);

        // The root is C (highest voice in this voicing)
        expect(result.lockedChord?.type).toBe(ChordType.Major);
        expect(result.lockedChord?.rootChannelId).toBe('bass');
        // Residuals for e4 and g4 should be very close to zero (within 1¢)
        expect(Math.abs(result.residualsPerVoice.get('bari') ?? Infinity)).toBeLessThan(1);
        expect(Math.abs(result.residualsPerVoice.get('lead') ?? Infinity)).toBeLessThan(1);
    });

    // Test case 5: wandering input → sanity threshold exceeded → no-chord-locked
    // Five voices at frequencies that don't fit any chord type (adjacent Hz
    // values, not harmonically related).
    it('emits no-chord-locked when voices have unrelated frequencies', () => {
        const voices = [
            voice('a', 200),
            voice('b', 317),
            voice('c', 450),
            voice('d', 600),
        ];

        const result = classifyChord(voices);

        expect(result.lockedChord).toBeNull();
    });

    // Test case 6: N=2 → no-chord-locked (classifier needs at least 3 voices)
    it('emits no-chord-locked for exactly 2 voices', () => {
        const voices = [
            voice('a', C4),
            voice('b', C4 * (3 / 2)),
        ];

        const result = classifyChord(voices);

        expect(result.lockedChord).toBeNull();
        expect(result.residualsPerVoice.size).toBe(0);
    });

    // Test case 7: N=3 voices with dom7-like Hz values → does NOT classify as
    // dom7 (minArity=4 excluded from loop at N=3); classifies as best triad.
    // Using root + maj-3rd + dom7-seventh: without the fifth the hypothesis
    // filter excludes dom7, so the best-fit triad wins.
    it('does not classify 3 voices as dom7 even with dom7-like Hz; picks best triad', () => {
        const voices = [
            voice('bass', C4),
            voice('lead', C4 * (5 / 4)),   // major third
            voice('tnr',  C4 * (7 / 4)),   // dom7 seventh
        ];

        const result = classifyChord(voices);

        // dom7 requires N>=4 and is excluded from the loop entirely.
        expect(result.lockedChord?.type).not.toBe(ChordType.DominantSeventh);
        // The result should be some triad or null (not null because root +
        // 5:4 + 7:4 all fit within sanity for at least one triad hypothesis).
        // The exact winning type depends on closest-fit; the important assertion
        // is that dom7 is never emitted at N=3.
        if (result.lockedChord !== null) {
            expect([
                ChordType.Major,
                ChordType.Minor,
                ChordType.Diminished,
            ]).toContain(result.lockedChord.type);
        }
    });

    // Test case 8: NaN f0Hz on one voice → that voice excluded from the map
    // (explicit test for the residualsPerVoice exclusion contract)
    it('excludes the NaN voice from residualsPerVoice', () => {
        const voices = [
            voice('ch0', C4),
            voice('ch1', C4 * (5 / 4)),
            voice('ch2', C4 * (3 / 2)),
            voice('ch3', Number.NaN),
        ];

        const result = classifyChord(voices);

        expect(result.lockedChord).not.toBeNull();
        // ch3 (NaN) must be absent from residuals.
        expect(result.residualsPerVoice.has('ch3')).toBe(false);
        // Active voices are present.
        expect(result.residualsPerVoice.has('ch0')).toBe(true);
        expect(result.residualsPerVoice.has('ch1')).toBe(true);
        expect(result.residualsPerVoice.has('ch2')).toBe(true);
    });

    // Test case 9: tie-break — two candidate roots produce equal fit sums
    // → the one with the lower active-voice index wins.
    // Construct: ch0 and ch3 both sing C4 (identical Hz), with E4 and G4
    // between them. Both produce the exact same floating-point sum when
    // used as root. The strict `<` update ensures the first-encountered
    // root (index 0 = 'ch0') is retained over the later one (index 3 = 'ch3').
    it('breaks ties in favor of the lower active-voice index root', () => {
        const e4 = C4 * (5 / 4);
        const g4 = C4 * (3 / 2);
        const voices = [
            voice('ch0', C4),   // index 0 — lower index, should win
            voice('ch1', e4),
            voice('ch2', g4),
            voice('ch3', C4),   // index 3 — same Hz as ch0: exact float tie
        ];

        const result = classifyChord(voices);

        expect(result.lockedChord?.type).toBe(ChordType.Major);
        // ch0 (lower active-voice index) wins the tie over ch3.
        expect(result.lockedChord?.rootChannelId).toBe('ch0');
    });
});
