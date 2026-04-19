// Plain-TypeScript YIN pitch detector. Tested by Vitest with synthesized
// sine waves; consumed by the AudioWorklet shell.

export interface PitchResult {
    fundamentalHz: number;   // 0 if no clear pitch
    confidence: number;      // 0..1
}

const DEFAULT_THRESHOLD = 0.15;

export function detectPitch(
    samples: Float32Array,
    sampleRate: number,
    threshold: number = DEFAULT_THRESHOLD,
): PitchResult {
    const bufferSize = samples.length;
    const halfBufferSize = Math.floor(bufferSize / 2);

    // 1. Difference function d(tau) = sum((x[i] - x[i+tau])^2)
    const diff = new Float32Array(halfBufferSize);
    for (let tau = 1; tau < halfBufferSize; tau++) {
        let sum = 0;
        for (let i = 0; i < halfBufferSize; i++) {
            const delta = samples[i] - samples[i + tau];
            sum += delta * delta;
        }
        diff[tau] = sum;
    }

    // 2. Cumulative mean normalised difference d'(tau)
    const cmnd = new Float32Array(halfBufferSize);
    cmnd[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < halfBufferSize; tau++) {
        runningSum += diff[tau];
        cmnd[tau] = diff[tau] * tau / (runningSum || 1);
    }

    // 3. Absolute threshold: first tau where cmnd dips below threshold and
    //    is a local minimum. diff[tau] > 0 guard rejects the all-zero (silence)
    //    case where d'(tau) is identically zero and would otherwise match.
    let tauEstimate = -1;
    for (let tau = 2; tau < halfBufferSize; tau++) {
        if (cmnd[tau] < threshold && diff[tau] > 0) {
            while (tau + 1 < halfBufferSize && cmnd[tau + 1] < cmnd[tau]) {
                tau++;
            }
            tauEstimate = tau;
            break;
        }
    }

    if (tauEstimate === -1) {
        return {fundamentalHz: 0, confidence: 0};
    }

    // 4. Parabolic interpolation around tauEstimate
    const x0 = tauEstimate < 1 ? tauEstimate : tauEstimate - 1;
    const x2 = tauEstimate + 1 < halfBufferSize ? tauEstimate + 1 : tauEstimate;
    const refined = parabolicInterp(x0, tauEstimate, x2, cmnd);
    const fundamentalHz = sampleRate / refined;

    // Confidence inverted from cmnd value (lower is better fit)
    const confidence = Math.max(0, Math.min(1, 1 - cmnd[tauEstimate]));

    return {fundamentalHz, confidence};
}

function parabolicInterp(x0: number, x1: number, x2: number, y: Float32Array): number {
    if (x0 === x1) {
        return y[x1] <= y[x2] ? x1 : x2;
    }
    if (x2 === x1) {
        return y[x1] <= y[x0] ? x1 : x0;
    }

    const s0 = y[x0];
    const s1 = y[x1];
    const s2 = y[x2];

    return x1 + 0.5 * (s2 - s0) / (2 * s1 - s2 - s0);
}
