// web/src/lab/ui/labAudioPlayer.browser.ts
import {describe, it, expect} from 'vitest';
import {LabAudioPlayer} from './labAudioPlayer';

const SAMPLE_RATE = 48000;

function tone(hz: number, seconds: number): AudioBuffer {
    const length = Math.ceil(seconds * SAMPLE_RATE);
    const buf = new AudioBuffer({numberOfChannels: 1, length, sampleRate: SAMPLE_RATE});
    const data = buf.getChannelData(0);
    for (let i = 0; i < length; i++) {
        data[i] = Math.sin(2 * Math.PI * hz * (i / SAMPLE_RATE));
    }

    return buf;
}

describe('LabAudioPlayer', () => {
    it('constructs, plays, switches, and disposes without throwing', async () => {
        // Arrange
        const ctx = new AudioContext({sampleRate: SAMPLE_RATE});
        const player = new LabAudioPlayer(ctx, tone(220, 0.4), tone(330, 0.4));

        // Act / Assert
        await player.play();
        expect(player.active).toBe('A');
        player.setActive('B');
        expect(player.active).toBe('B');
        await player.pause();
        player.dispose();
        await ctx.close();
    });
});
