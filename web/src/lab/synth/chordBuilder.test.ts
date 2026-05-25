// web/src/lab/synth/chordBuilder.test.ts
import {describe, it, expect} from 'vitest';
import {buildChord, VOWEL_PRESETS, type ChordQuality} from './chordBuilder';

const ROOT = 220;

describe('buildChord', () => {
    it('majorTriad has 3 voices at JI 4:5:6 off the root', () => {
        // Arrange / Act
        const chord = buildChord(ROOT, 'majorTriad', VOWEL_PRESETS.schwa);

        // Assert
        expect(chord.voices.map((v) => v.fundamentalHz)).toEqual([ROOT, ROOT * (5 / 4), ROOT * (3 / 2)]);
    });

    it('dom7 has 4 voices at JI 4:5:6:7 off the root', () => {
        // Arrange / Act
        const chord = buildChord(ROOT, 'dom7', VOWEL_PRESETS.schwa);

        // Assert
        expect(chord.voices.map((v) => v.fundamentalHz)).toEqual([ROOT, ROOT * (5 / 4), ROOT * (3 / 2), ROOT * (7 / 4)]);
    });

    it('stamps the preset formants and partials onto every voice', () => {
        // Arrange / Act
        const chord = buildChord(ROOT, 'dom7', VOWEL_PRESETS.ee);

        // Assert
        for (const v of chord.voices) {
            expect(v.f1Hz).toBe(VOWEL_PRESETS.ee.f1Hz);
            expect(v.f2Hz).toBe(VOWEL_PRESETS.ee.f2Hz);
            expect(v.partialAmplitudes).toEqual(VOWEL_PRESETS.ee.partialAmplitudes);
        }
    });

    it('holds all human-variance dimensions at neutral (zero) so only a swept axis moves', () => {
        // Arrange / Act
        const chord = buildChord(ROOT, 'dom7', VOWEL_PRESETS.ah);

        // Assert
        for (const v of chord.voices) {
            expect(v.driftCents).toBe(0);
            expect(v.jitterCents).toBe(0);
            expect(v.vibratoDepthCents).toBe(0);
            expect(v.onsetOffsetMs).toBe(0);
        }
    });

    it('does not alias partialAmplitudes across voices (independent arrays)', () => {
        // Arrange
        const chord = buildChord(ROOT, 'majorTriad', VOWEL_PRESETS.schwa);

        // Act
        chord.voices[0].partialAmplitudes[0] = 999;

        // Assert
        expect(chord.voices[1].partialAmplitudes[0]).not.toBe(999);
    });

    it('exposes a non-empty preset table for the config dropdown', () => {
        // Arrange / Act
        const names = Object.keys(VOWEL_PRESETS);

        // Assert
        expect(names).toContain('schwa');
        expect(names.length).toBeGreaterThanOrEqual(2);
    });

    it('rejects a non-finite or non-positive root', () => {
        // Arrange
        const bad: number[] = [0, -10, Number.NaN, Number.POSITIVE_INFINITY];

        // Act / Assert
        for (const r of bad) {
            expect(() => buildChord(r, 'dom7' as ChordQuality, VOWEL_PRESETS.schwa)).toThrow();
        }
    });
});
