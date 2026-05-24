import {describe, expect, it} from 'vitest';
import {renderChord} from './chordSynth';
import {neutralVoiceParams, type ChordParams} from './voiceParams';
import {rms} from './synthTestUtils';

const SAMPLE_RATE = 48000;

// dom7 in just intonation over a 220 Hz root: 4:5:6:7.
function dom7Chord(): ChordParams {
    const root = 220;
    return {
        voices: [
            neutralVoiceParams(root),
            neutralVoiceParams((root * 5) / 4),
            neutralVoiceParams((root * 3) / 2),
            neutralVoiceParams((root * 7) / 4),
        ],
    };
}

describe('renderChord', () => {
    it('renders a non-silent buffer of the requested duration', async () => {
        // Arrange
        const durationS = 1.5;

        // Act
        const buffer = await renderChord(dom7Chord(), 1000, durationS, SAMPLE_RATE);

        // Assert
        expect(buffer.length).toBe(Math.ceil(durationS * SAMPLE_RATE));
        expect(rms(buffer.getChannelData(0))).toBeGreaterThan(0.001);
    });

    it('is deterministic for the same seed base', async () => {
        // Arrange
        const chord = dom7Chord();

        // Act
        const a = await renderChord(chord, 2000, 1, SAMPLE_RATE);
        const b = await renderChord(chord, 2000, 1, SAMPLE_RATE);
        const da = a.getChannelData(0);
        const db = b.getChannelData(0);

        // Assert: reproducible to within single-float epsilon. WebAudio offline
        // rendering is not bit-exact across runs (summation order / denormal
        // handling differ by ~2^-24, about 6e-8); the seeded drift/jitter curve
        // is identical, so any residual delta is float noise far below audible
        // significance.
        expect(da.length).toBe(db.length);
        let maxDelta = 0;
        for (let i = 0; i < da.length; i++) {
            maxDelta = Math.max(maxDelta, Math.abs(da[i] - db[i]));
        }
        expect(maxDelta).toBeLessThan(1e-6);
    });
});
