// web/src/lab/ui/seamlessLoop.browser.ts
import {describe, it, expect} from 'vitest';
import {makeSeamlessLoopBuffer} from './seamlessLoop';

const SAMPLE_RATE = 48000;

// Build a 1-channel buffer of `seconds` filled by `fn(t)`.
function bufferOf(seconds: number, fn: (t: number) => number): AudioBuffer {
    const length = Math.ceil(seconds * SAMPLE_RATE);
    const buf = new AudioBuffer({numberOfChannels: 1, length, sampleRate: SAMPLE_RATE});
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) {
        data[i] = fn(i / SAMPLE_RATE);
    }

    return buf;
}

describe('makeSeamlessLoopBuffer', () => {
    it('returns a buffer trimmed to (loopEnd-loopStart-crossfade) length', () => {
        // Arrange
        const src = bufferOf(1.7, (t) => Math.sin(2 * Math.PI * 220 * t));
        const loopStartS = 0.1;
        const loopEndS = 1.5;
        const crossfadeS = 0.02;

        // Act
        const out = makeSeamlessLoopBuffer(src, loopStartS, loopEndS, crossfadeS);

        // Assert
        const expectedLen = Math.round((loopEndS - loopStartS - crossfadeS) * SAMPLE_RATE);
        expect(Math.abs(out.length - expectedLen)).toBeLessThanOrEqual(1);
    });

    it('produces a wrap with no large discontinuity at the seam', () => {
        // Arrange: a non-harmonic tone so a naive hard loop WOULD click.
        const src = bufferOf(1.7, (t) => Math.sin(2 * Math.PI * 333.7 * t));

        // Act
        const out = makeSeamlessLoopBuffer(src, 0.1, 1.5, 0.02);
        const data = out.getChannelData(0);

        // Assert: last sample to first sample step is small (seam is crossfaded).
        const seamStep = Math.abs(data[0] - data[data.length - 1]);
        expect(seamStep).toBeLessThan(0.1);
    });

    it('clamps crossfade to the available region and never throws on a short loop', () => {
        // Arrange
        const src = bufferOf(0.3, (t) => Math.sin(2 * Math.PI * 220 * t));

        // Act / Assert
        expect(() => makeSeamlessLoopBuffer(src, 0.05, 0.25, 0.5)).not.toThrow();
    });
});
