import {describe, expect, it} from 'vitest';
import {ChordHysteresis} from './chordHysteresis';
import {classifyChord, type ClassifierResult} from './chordClassifier';
import {ChordType} from '../wire/chord';

// Helper: build a VoiceObservation array from Hz values keyed by channelId.
const voices = (entries: Record<string, number>) =>
    Object.entries(entries).map(([channelId, f0Hz]) => ({
        channelId,
        f0Hz,
        slotIndex: 0,
        gateOpen: true,
    }));

// Prebuilt chord inputs.
const C4 = 261.626;

const dom7Voices = voices({
    bass: C4,
    bari: C4 * (5 / 4),
    lead: C4 * (3 / 2),
    tnr:  C4 * (7 / 4),
});

const majorVoices = voices({
    bass: C4,
    bari: C4 * (5 / 4),
    lead: C4 * (3 / 2),
});

const minor7Voices = voices({
    bass: C4,
    bari: C4 * (6 / 5),
    lead: C4 * (3 / 2),
    tnr:  C4 * (9 / 5),
});

// null-chord result for use when classifier would emit no-chord.
const noChord: ClassifierResult = {lockedChord: null, residualsPerVoice: new Map()};

describe('ChordHysteresis', () => {
    it('1-frame outlier preserves lock: dom7 → minor7 → dom7 stays dom7-locked', () => {
        const h = new ChordHysteresis();

        // Establish dom7 lock after HYSTERESIS_FRAMES (2) matching frames.
        h.step(classifyChord(dom7Voices), 4); // counter=1 (Rule C: new candidate)
        const after2 = h.step(classifyChord(dom7Voices), 4); // counter=2 → promote

        expect(after2.lockedChord?.type).toBe(ChordType.DominantSeventh);

        // One-frame outlier: minor7 at same voice count.
        const afterOutlier = h.step(classifyChord(minor7Voices), 4);
        // Lock must still be dom7.
        expect(afterOutlier.lockedChord?.type).toBe(ChordType.DominantSeventh);

        // Return to dom7: Rule B fires, lock confirmed.
        const afterReturn = h.step(classifyChord(dom7Voices), 4);
        expect(afterReturn.lockedChord?.type).toBe(ChordType.DominantSeventh);
    });

    it('2-frame persistent change promotes: dom7 → major × 2 ends locked on major', () => {
        const h = new ChordHysteresis();

        // Lock dom7 first.
        h.step(classifyChord(dom7Voices), 4);
        h.step(classifyChord(dom7Voices), 4); // dom7 locked

        // Switch to major (3 voices).
        h.step(classifyChord(majorVoices), 3); // Rule C: candidate=major, counter=1
        const afterSecond = h.step(classifyChord(majorVoices), 3); // Rule A: counter=2 → promote

        expect(afterSecond.lockedChord?.type).toBe(ChordType.Major);
    });

    it('voice-count decrease resets candidate counter', () => {
        const h = new ChordHysteresis();

        // Lock dom7 first.
        h.step(classifyChord(dom7Voices), 4);
        h.step(classifyChord(dom7Voices), 4); // dom7 locked

        // Introduce major candidate at 4 voices.
        h.step(classifyChord(majorVoices), 4); // Rule C: candidate=major, counter=1

        // Voice count decreases: counter should reset.
        // With only 3 voices the classifier may still find major — but
        // the counter resets, so we need 2 more matching frames to promote.
        const r3 = classifyChord(majorVoices);
        const afterDecrease = h.step(r3, 3); // counter resets to 0 then Rule C sets to 1

        // Lock must NOT yet be major (only 1 frame since reset).
        expect(afterDecrease.lockedChord?.type).not.toBe(ChordType.Major);
        // But one more matching frame should promote.
        const afterSecond = h.step(classifyChord(majorVoices), 3); // counter=2 → promote
        expect(afterSecond.lockedChord?.type).toBe(ChordType.Major);
    });

    it('voice-count increase N=3→N=4 also resets candidate counter', () => {
        const h = new ChordHysteresis();

        // Lock a triad at N=3.
        const triadVoices = voices({bass: C4, bari: C4 * (5 / 4), lead: C4 * (3 / 2)});
        h.step(classifyChord(triadVoices), 3);
        h.step(classifyChord(triadVoices), 3); // major locked

        // Build dom7 candidate at N=3 (single frame; counter=1 — but
        // dom7 isn't even in the hypothesis set at N=3 so this stays
        // at major. Instead use a Different triad as a candidate.)
        const minorVoices = voices({bass: C4, bari: C4 * (6 / 5), lead: C4 * (3 / 2)});
        h.step(classifyChord(minorVoices), 3); // Rule C: candidate=minor, counter=1

        // Voice count crosses 3→4: candidate counter resets to 0. Now
        // the dom7 hypothesis is open; a single matching frame would
        // otherwise have promoted (counter=2) if no reset.
        const dom7Frame = classifyChord(dom7Voices);
        const afterIncrease = h.step(dom7Frame, 4); // counter resets, then Rule C: counter=1

        // major lock preserved; dom7 not yet promoted (only 1 frame since reset).
        expect(afterIncrease.lockedChord?.type).toBe(ChordType.Major);
        // One more matching frame promotes.
        const afterSecond = h.step(classifyChord(dom7Voices), 4);
        expect(afterSecond.lockedChord?.type).toBe(ChordType.DominantSeventh);
    });

    it('validity guard fires on N=4→N=3: locked dom7 clears immediately', () => {
        const h = new ChordHysteresis();

        // Lock dom7 (minArity=4).
        h.step(classifyChord(dom7Voices), 4);
        const locked = h.step(classifyChord(dom7Voices), 4);
        expect(locked.lockedChord?.type).toBe(ChordType.DominantSeventh);

        // Drop to 3 voices: dom7 minArity (4) > activeCount (3) → clear.
        const result = h.step(noChord, 3);
        expect(result.lockedChord).toBeNull();
    });

    it('validity guard fires on N=5→N=3 (non-boundary case)', () => {
        const h = new ChordHysteresis();

        // Lock dom7 at 5 voices (dom7 still wins since minArity=4 ≤ 5).
        const fiveVoices = voices({
            bass: C4,
            bari: C4 * (5 / 4),
            lead: C4 * (3 / 2),
            tnr:  C4 * (7 / 4),
            extra: C4 * 2, // doubled root, octave-reduced = 0
        });
        h.step(classifyChord(fiveVoices), 5);
        const locked = h.step(classifyChord(fiveVoices), 5);
        expect(locked.lockedChord?.type).toBe(ChordType.DominantSeventh);

        // Jump directly from 5 to 3 voices (skips the 4→3 boundary).
        const result = h.step(noChord, 3);
        expect(result.lockedChord).toBeNull();
    });

    it('validity guard + pending candidate: both locked and candidate clear', () => {
        const h = new ChordHysteresis();

        // Lock dom7 at 4 voices.
        h.step(classifyChord(dom7Voices), 4);
        const locked = h.step(classifyChord(dom7Voices), 4);
        expect(locked.lockedChord?.type).toBe(ChordType.DominantSeventh);

        // Introduce a minor candidate (counter=1, not yet promoted).
        const minorVoices = voices({
            bass: C4,
            bari: C4 * (6 / 5),
            lead: C4 * (3 / 2),
            tnr:  C4 * (7 / 4), // close-ish to minor7 target but still best-fit minor
        });
        h.step(classifyChord(minorVoices), 4); // Rule C: candidate, counter=1

        // Drop to 3 voices: validity guard clears locked dom7 AND
        // the candidate/counter reset path clears the pending candidate.
        const result = h.step(noChord, 3);
        expect(result.lockedChord).toBeNull();

        // A subsequent major frame needs 2 more hits (fresh start, no residue).
        const afterMajor1 = h.step(classifyChord(majorVoices), 3);
        expect(afterMajor1.lockedChord).toBeNull();
        const afterMajor2 = h.step(classifyChord(majorVoices), 3);
        expect(afterMajor2.lockedChord?.type).toBe(ChordType.Major);
    });

    it('triad-locked + voice removal stays locked when remaining 3 voices fit', () => {
        const h = new ChordHysteresis();

        // Lock major at 4 voices (doubled root occupies 4th slot).
        const fourVoiceMajor = voices({
            bass:  C4,
            bari:  C4 * (5 / 4),
            lead:  C4 * (3 / 2),
            extra: C4 * 2, // octave-doubled root
        });
        h.step(classifyChord(fourVoiceMajor), 4);
        const locked = h.step(classifyChord(fourVoiceMajor), 4);
        expect(locked.lockedChord?.type).toBe(ChordType.Major);

        // Remove one voice → N=3. Major minArity=3 ≤ 3, so validity guard
        // must NOT clear the lock.
        const result = h.step(classifyChord(majorVoices), 3);
        expect(result.lockedChord?.type).toBe(ChordType.Major);
    });
});
