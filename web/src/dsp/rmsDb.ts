// RMS level in dBFS for a PCM frame. Pure: no DOM / AudioWorklet state, so
// tests can drive it directly with a Float32Array and the worklet shell can
// reuse it without pulling in DSP concerns.

const SILENCE_FLOOR_DB = -120;
const SILENCE_RMS_EPSILON = 1e-9;

export function computeRmsDb(buffer: Float32Array): number {
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
        sumSquares += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sumSquares / buffer.length);
    if (rms <= SILENCE_RMS_EPSILON) {
        return SILENCE_FLOOR_DB;
    }

    return 20 * Math.log10(rms);
}
