// Minimal mono PCM WAV reader. Counterpart to wav-utils.mjs's writer
// side; consumed by the LPC spike benchmark and any future generator
// scripts that need to round-trip a fixture for verification. PCM
// only - the test fixtures (gen-test-audio.mjs, gen-staccato-audio.mjs)
// always emit 16-bit PCM mono so this reader matches the same shape
// rather than implementing a full WAVE parser.
//
// Layout reference (offset / size / field) - matches wav-utils.mjs:
//   0   4  'RIFF'
//   4   4  fileSize - 8
//   8   4  'WAVE'
//   12  4  'fmt '
//   16  4  PCM fmt chunk size = 16
//   20  2  AudioFormat = 1 (PCM)
//   22  2  NumChannels
//   24  4  SampleRate
//   28  4  ByteRate
//   32  2  BlockAlign
//   34  2  BitsPerSample
//   36  4  'data'
//   40  4  dataSize
//   44+ samples
import {readFileSync} from 'node:fs';

export const WAV_HEADER_BYTES = 44;

export function readWavFile(path) {
    const raw = readFileSync(path);
    const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

    if (buf.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error(`Not a RIFF file: ${path}`);
    }
    if (buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`Not a WAVE file: ${path}`);
    }
    if (buf.toString('ascii', 12, 16) !== 'fmt ') {
        throw new Error(`Missing 'fmt ' chunk: ${path}`);
    }

    const audioFormat = buf.readUInt16LE(20);
    if (audioFormat !== 1) {
        throw new Error(`Unsupported format ${audioFormat} (PCM only): ${path}`);
    }
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);

    if (buf.toString('ascii', 36, 40) !== 'data') {
        throw new Error(`Missing 'data' chunk: ${path}`);
    }
    const dataByteLength = buf.readUInt32LE(40);
    const sampleCount = dataByteLength / (channels * bitsPerSample / 8);

    const samples = new Float32Array(sampleCount);
    if (bitsPerSample === 16) {
        // Mix multi-channel down to mono by averaging; the test fixtures
        // are mono today but the generator could conceivably switch.
        for (let i = 0; i < sampleCount; i++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) {
                const offset = WAV_HEADER_BYTES + (i * channels + c) * 2;
                sum += buf.readInt16LE(offset);
            }
            samples[i] = (sum / channels) / 32768;
        }
    }
    else if (bitsPerSample === 32) {
        // 32-bit PCM (less common but possible). Same averaging.
        for (let i = 0; i < sampleCount; i++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) {
                const offset = WAV_HEADER_BYTES + (i * channels + c) * 4;
                sum += buf.readInt32LE(offset);
            }
            samples[i] = (sum / channels) / 2147483648;
        }
    }
    else {
        throw new Error(`Unsupported bits-per-sample ${bitsPerSample}: ${path}`);
    }

    return {samples, sampleRate, channels, bitsPerSample};
}
