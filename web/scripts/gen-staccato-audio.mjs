// Emits web/test-fixtures/staccato-vowel.wav: 60 s, 48 kHz, 16-bit
// mono PCM. Each cycle is 200 ms of 220 Hz sine tone (A3,
// comfortably inside the plot's [80, 600] Hz window and the YIN
// detector's confident range) followed by 100 ms of digital
// silence; the display gate flips at ~3 Hz. Used by Playwright's
// --use-file-for-fake-audio-capture in
// staccato-smoothness.spec.ts to lock the line-list / single-draw
// architectural win against future regressions
// (.claude/specs/2026-04-30-webgpu-plot-prototype.md).
//
// Format matches sustained-vowel.wav so the same Chromium fake-
// audio path works without resampling. Chromium loops the file
// when playback reaches its end, which is fine for a test that
// observes 60 s and the fixture happens to be exactly 60 s — no
// loop-boundary artefact within the observation window.
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const TONE_HZ = 220;
const TONE_MS = 200;
const SILENCE_MS = 100;
const TOTAL_MS = 60_000;

const TONE_SAMPLES = (SAMPLE_RATE * TONE_MS) / 1000;
const SILENCE_SAMPLES = (SAMPLE_RATE * SILENCE_MS) / 1000;
const CYCLE_SAMPLES = TONE_SAMPLES + SILENCE_SAMPLES;
const TOTAL_SAMPLES = (SAMPLE_RATE * TOTAL_MS) / 1000;

const dataSize = TOTAL_SAMPLES * (BITS_PER_SAMPLE / 8) * CHANNELS;
const fileSize = 44 + dataSize;
const buffer = Buffer.alloc(fileSize);

// RIFF header.
buffer.write('RIFF', 0, 'ascii');
buffer.writeUInt32LE(fileSize - 8, 4);
buffer.write('WAVE', 8, 'ascii');

// fmt chunk.
buffer.write('fmt ', 12, 'ascii');
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(CHANNELS, 22);
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE((SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8, 28);
buffer.writeUInt16LE((CHANNELS * BITS_PER_SAMPLE) / 8, 32);
buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);

// data chunk.
buffer.write('data', 36, 'ascii');
buffer.writeUInt32LE(dataSize, 40);

// Tone amplitude: 70% of int16 range. Loud enough to pass YIN
// confidence reliably, quiet enough that any future test code
// that gain-stages doesn't clip.
const amplitude = Math.round(0x7fff * 0.7);
const angularStepPerSample = (2 * Math.PI * TONE_HZ) / SAMPLE_RATE;

for (let i = 0; i < TOTAL_SAMPLES; i += 1) {
    const positionInCycle = i % CYCLE_SAMPLES;
    let sample = 0;
    if (positionInCycle < TONE_SAMPLES) {
        // Phase resets to 0 at each tone-burst start (positionInCycle
        // counts from 0). YIN doesn't care about phase continuity
        // across silence boundaries since it operates on an
        // autocorrelation window inside each burst.
        sample = Math.round(amplitude * Math.sin(positionInCycle * angularStepPerSample));
    }
    buffer.writeInt16LE(sample, 44 + i * 2);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '..', 'test-fixtures');
mkdirSync(outDir, {recursive: true});
const outPath = join(outDir, 'staccato-vowel.wav');
writeFileSync(outPath, buffer);

console.log(`Wrote ${outPath} (${(dataSize / 1024 / 1024).toFixed(1)} MB, ${TOTAL_MS / 1000} s)`);
