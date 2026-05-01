// Shared WAV (RIFF / WAVE) header writer for the test-audio
// generator scripts in this directory. The PCM 44-byte header
// layout doesn't change across our fixtures (`gen-test-audio.mjs`
// for sustained vowel + harmonics, `gen-staccato-audio.mjs` for
// staccato bursts), so the layout lives here once instead of
// being copied per script.
//
// Format constants are PCM only; we don't need to support float
// PCM or extensible WAVE for these test fixtures.
//
// Layout reference (offset / size / field):
//   0   4  'RIFF'
//   4   4  fileSize - 8
//   8   4  'WAVE'
//   12  4  'fmt '
//   16  4  PCM fmt chunk size = 16
//   20  2  AudioFormat = 1 (PCM)
//   22  2  NumChannels
//   24  4  SampleRate
//   28  4  ByteRate = SampleRate * NumChannels * BitsPerSample / 8
//   32  2  BlockAlign = NumChannels * BitsPerSample / 8
//   34  2  BitsPerSample
//   36  4  'data'
//   40  4  dataSize
//   44+ samples
import {Buffer} from 'node:buffer';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const WAV_HEADER_BYTES = 44;

// web/test-fixtures/ resolved from this file's location. The
// fixtures directory lives at web/test-fixtures/, this file at
// web/scripts/wav-utils.mjs - one '..' hop. Both generator scripts
// are siblings in web/scripts/ and share this resolution rather
// than constructing it independently.
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');

// Write a complete WAV buffer to web/test-fixtures/<filename> and
// log the size (and optional duration in seconds). Centralises the
// file-writing boilerplate shared by the audio generator scripts
// in this directory; callers compose the buffer (header + samples)
// and pass it in. Data byte count is derived from the buffer:
// WAV_HEADER_BYTES is the only constant overhead.
export function writeWavFile(filename, buffer, durationSeconds) {
    mkdirSync(FIXTURES_DIR, {recursive: true});
    const outPath = join(FIXTURES_DIR, filename);
    writeFileSync(outPath, buffer);
    const dataByteLength = buffer.length - WAV_HEADER_BYTES;
    const sizeStr = `${(dataByteLength / 1024 / 1024).toFixed(1)} MB`;
    const durStr = durationSeconds !== undefined ? `, ${durationSeconds} s` : '';
    console.log(`Wrote ${outPath} (${sizeStr}${durStr})`);

    return outPath;
}

export function writeWavHeader(buffer, dataByteLength, sampleRate, channels, bitsPerSample) {
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(WAV_HEADER_BYTES + dataByteLength - 8, 4);
    buffer.write('WAVE', 8, 'ascii');

    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
    buffer.writeUInt16LE((channels * bitsPerSample) / 8, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataByteLength, 40);
}
