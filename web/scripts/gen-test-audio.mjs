// Emits web/test-fixtures/sustained-vowel.wav: 90 s, 48 kHz, 16-bit
// mono PCM. Fundamental 220 Hz plus harmonics; light vibrato so YIN
// has something to bite on and the plot has visible trace movement.
// Used by Playwright's --use-file-for-fake-audio-capture.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

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

const header = Buffer.alloc(44);
const dataBytes = pcm.byteLength;
header.write('RIFF', 0);
header.writeUInt32LE(36 + dataBytes, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SAMPLE_RATE, 24);
header.writeUInt32LE(SAMPLE_RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(dataBytes, 40);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '..', 'test-fixtures');
mkdirSync(outDir, {recursive: true});
const outPath = join(outDir, 'sustained-vowel.wav');
writeFileSync(outPath, Buffer.concat([header, Buffer.from(pcm.buffer)]));
console.log(`Wrote ${outPath} (${(dataBytes / 1024 / 1024).toFixed(1)} MB)`);
