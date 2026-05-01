// Emits web/test-fixtures/sustained-vowel.wav: 90 s, 48 kHz, 16-bit
// mono PCM. Fundamental 220 Hz plus harmonics; light vibrato so YIN
// has something to bite on and the plot has visible trace movement.
// Used by Playwright's --use-file-for-fake-audio-capture.
import {WAV_HEADER_BYTES, writeWavFile, writeWavHeader} from './wav-utils.mjs';

const SAMPLE_RATE = 48_000;
const DURATION_S = 90;
const FUNDAMENTAL_HZ = 220;
const VIBRATO_HZ = 5.5;
const VIBRATO_CENTS = 15;
const HARMONIC_AMPS = [1.0, 0.5, 0.3, 0.2, 0.12, 0.08];

const totalSamples = SAMPLE_RATE * DURATION_S;
const pcm = new Int16Array(totalSamples);
const gain = 0.35;

let phaseFund = 0;
const twoPi = Math.PI * 2;
for (let i = 0; i < totalSamples; i += 1) {
    const t = i / SAMPLE_RATE;
    const cents = Math.sin(twoPi * VIBRATO_HZ * t) * VIBRATO_CENTS;
    const freq = FUNDAMENTAL_HZ * Math.pow(2, cents / 1200);
    phaseFund += (twoPi * freq) / SAMPLE_RATE;
    let sample = 0;
    for (let h = 0; h < HARMONIC_AMPS.length; h += 1) {
        sample += HARMONIC_AMPS[h] * Math.sin(phaseFund * (h + 1));
    }
    const clipped = Math.max(-1, Math.min(1, sample * gain));
    pcm[i] = Math.round(clipped * 32767);
}

const dataBytes = pcm.byteLength;
const buffer = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);
writeWavHeader(buffer, dataBytes, SAMPLE_RATE, 1, 16);
Buffer.from(pcm.buffer).copy(buffer, WAV_HEADER_BYTES);
writeWavFile('sustained-vowel.wav', buffer);
