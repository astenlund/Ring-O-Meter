import {describe, expect, it} from 'vitest';
import {buildVoice} from './voiceGraph';
import {neutralVoiceParams} from './voiceParams';

const SAMPLE_RATE = 48000;

// Goertzel single-bin magnitude at targetHz over the given samples.
function goertzelMagnitude(samples: Float32Array, targetHz: number, sampleRate: number): number {
    const k = Math.round((samples.length * targetHz) / sampleRate);
    const w = (2 * Math.PI * k) / samples.length;
    const cosW = Math.cos(w);
    const coeff = 2 * cosW;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < samples.length; i++) {
        const s0 = samples[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const real = s1 - s2 * cosW;
    const imag = s2 * Math.sin(w);
    return Math.sqrt(real * real + imag * imag) / samples.length;
}

function rms(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
}

describe('buildVoice', () => {
    it('renders a non-silent tone with energy at the fundamental', async () => {
        // Arrange
        const durationS = 1;
        const ctx = new OfflineAudioContext(1, SAMPLE_RATE * durationS, SAMPLE_RATE);
        const params = neutralVoiceParams(220);

        // Act
        const voice = buildVoice(ctx, params, 1, durationS);
        voice.output.connect(ctx.destination);
        voice.start(0);
        const buffer = await ctx.startRendering();
        const data = buffer.getChannelData(0);

        // Assert
        expect(rms(data)).toBeGreaterThan(0.001);
        const atFundamental = goertzelMagnitude(data, 220, SAMPLE_RATE);
        const offTone = goertzelMagnitude(data, 137, SAMPLE_RATE);
        expect(atFundamental).toBeGreaterThan(offTone * 4);
    });

    it('stays silent until the onset offset', async () => {
        // Arrange
        const durationS = 1;
        const ctx = new OfflineAudioContext(1, SAMPLE_RATE * durationS, SAMPLE_RATE);
        const params = {...neutralVoiceParams(220), onsetOffsetMs: 500};

        // Act
        const voice = buildVoice(ctx, params, 1, durationS);
        voice.output.connect(ctx.destination);
        voice.start(0);
        const buffer = await ctx.startRendering();
        const data = buffer.getChannelData(0);
        const preOnset = data.subarray(0, Math.floor(SAMPLE_RATE * 0.4));
        const postOnset = data.subarray(Math.floor(SAMPLE_RATE * 0.6));

        // Assert
        expect(rms(preOnset)).toBeLessThan(0.0005);
        expect(rms(postOnset)).toBeGreaterThan(0.001);
    });

    it('renders source harmonics shaped by the formant bandpasses', async () => {
        // Arrange
        const durationS = 1;
        const ctx = new OfflineAudioContext(1, SAMPLE_RATE * durationS, SAMPLE_RATE);
        const params = neutralVoiceParams(220); // partials at 440, 660, 880...; F1=600, F2=1200

        // Act
        const voice = buildVoice(ctx, params, 1, durationS);
        voice.output.connect(ctx.destination);
        voice.start(0);
        const data = (await ctx.startRendering()).getChannelData(0);

        // Assert: partials 2 (440) and 3 (660) are present (PeriodicWave index
        // mapping correct), and the 3rd partial sitting on F1 (660 vs F1=600)
        // carries more energy than the 4th partial (880), a real harmonic in the
        // valley between F1 and F2, so the bandpasses genuinely shape the spectrum.
        const partial2 = goertzelMagnitude(data, 440, SAMPLE_RATE);
        const partial3 = goertzelMagnitude(data, 660, SAMPLE_RATE);
        const partial4 = goertzelMagnitude(data, 880, SAMPLE_RATE);
        expect(partial2).toBeGreaterThan(0);
        expect(partial3).toBeGreaterThan(partial4 * 2);
    });

    it('adds vibrato sidebands only when depth > 0', async () => {
        // Arrange
        const durationS = 1;
        const renderOne = async (depthCents: number): Promise<Float32Array> => {
            const ctx = new OfflineAudioContext(1, SAMPLE_RATE * durationS, SAMPLE_RATE);
            const params = {...neutralVoiceParams(220), vibratoRateHz: 6, vibratoDepthCents: depthCents};
            const voice = buildVoice(ctx, params, 1, durationS);
            voice.output.connect(ctx.destination);
            voice.start(0);
            return (await ctx.startRendering()).getChannelData(0);
        };

        // Act
        const dry = await renderOne(0);
        const wet = await renderOne(50);

        // Assert: 6 Hz vibrato puts energy in a sideband ~6 Hz off the fundamental
        // (226 Hz) that the depth-0 render lacks. The same bandpass shapes both
        // renders, so the comparison isolates the LFO's effect.
        const drySide = goertzelMagnitude(dry, 226, SAMPLE_RATE);
        const wetSide = goertzelMagnitude(wet, 226, SAMPLE_RATE);
        expect(wetSide).toBeGreaterThan(drySide * 3);
    });
});
