import {describe, expect, it} from 'vitest';
import {neutralVoiceParams, PARTIAL_COUNT} from './voiceParams';

describe('neutralVoiceParams', () => {
    it('carries exactly PARTIAL_COUNT (7) partial amplitudes for partials 2..8', () => {
        // Arrange / Act
        const v = neutralVoiceParams(220);

        // Assert
        expect(PARTIAL_COUNT).toBe(7);
        expect(v.partialAmplitudes).toHaveLength(PARTIAL_COUNT);
    });

    it('sets the requested fundamental and silent variance defaults', () => {
        // Arrange / Act
        const v = neutralVoiceParams(196);

        // Assert
        expect(v.fundamentalHz).toBe(196);
        expect(v.driftCents).toBe(0);
        expect(v.jitterCents).toBe(0);
        expect(v.vibratoDepthCents).toBe(0);
        expect(v.onsetOffsetMs).toBe(0);
    });

    it('returns positive formant centers with F2 above F1', () => {
        // Arrange / Act
        const v = neutralVoiceParams(220);

        // Assert
        expect(v.f1Hz).toBeGreaterThan(0);
        expect(v.f2Hz).toBeGreaterThan(v.f1Hz);
    });
});
