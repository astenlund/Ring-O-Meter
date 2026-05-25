// web/src/lab/ui/labAudioPlayer.browser.ts
import {describe, it, expect} from 'vitest';
import {equalPowerGains, LabAudioPlayer} from './labAudioPlayer';

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

describe('equalPowerGains', () => {
    it('is (1,0) at t=0 and (0,1) at t=1', () => {
        // Arrange / Act / Assert
        expect(equalPowerGains(0)).toEqual([expect.closeTo(1, 5), expect.closeTo(0, 5)]);
        expect(equalPowerGains(1)).toEqual([expect.closeTo(0, 5), expect.closeTo(1, 5)]);
    });

    it('preserves power: a^2 + b^2 === 1 across t', () => {
        // Arrange / Act / Assert
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            const [a, b] = equalPowerGains(t);
            expect(a * a + b * b).toBeCloseTo(1, 5);
        }
    });
});

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
