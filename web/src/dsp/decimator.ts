// Anti-aliased integer decimator. Convolves the input with a windowed-sinc
// low-pass FIR, then keeps every Mth output sample. Without the FIR,
// frequency content above the new Nyquist would alias into the analysis
// band; with it, content above the cutoff is suppressed by ~50 dB+
// (Hamming window gives ~53 dB minimum stop-band attenuation).
//
// Stateful per instance; not thread-safe. Carries the FIR delay line
// across calls so the filter is continuous at frame boundaries (same
// reasoning as PreEmphasis - resetting per frame would inject a
// transient at every frame edge).
//
// Use the static factory `createForRate` to build an instance for a
// specific input/output rate pair; it picks tap count, cutoff, and
// computes the windowed-sinc coefficients once.

const DEFAULT_TAP_COUNT = 64;

export interface DecimatorSpec {
    inputRate: number;
    outputRate: number;
    cutoffHz: number;
    taps?: number;
}

export class Decimator {
    private readonly coeffs: Float32Array;
    private readonly factor: number;
    private readonly delay: Float32Array;
    private delayHead = 0; // points at the slot holding the newest input sample
    private inputsSinceOutput = 0;

    public constructor(spec: DecimatorSpec) {
        if (!Number.isInteger(spec.inputRate / spec.outputRate)) {
            throw new Error(
                `Decimator: inputRate ${spec.inputRate} must be an integer multiple of outputRate ${spec.outputRate}`,
            );
        }
        this.factor = spec.inputRate / spec.outputRate;
        const tapCount = spec.taps ?? DEFAULT_TAP_COUNT;
        this.coeffs = designWindowedSinc(tapCount, spec.cutoffHz, spec.inputRate);
        this.delay = new Float32Array(tapCount);
    }

    public get decimationFactor(): number {
        return this.factor;
    }

    public get tapCount(): number {
        return this.coeffs.length;
    }

    // Process one input frame. Writes up to `floor((input.length + carry) / factor)`
    // output samples; returns the count actually written. Output buffer must
    // have capacity for at least `Math.ceil(input.length / factor)` samples.
    public process(input: Float32Array, output: Float32Array): number {
        const N = this.coeffs.length;
        const factor = this.factor;
        const delay = this.delay;
        const coeffs = this.coeffs;
        let head = this.delayHead;
        let counter = this.inputsSinceOutput;
        let outIdx = 0;

        for (let i = 0; i < input.length; i++) {
            // Advance head, write newest sample.
            head = head + 1;
            if (head === N) {
                head = 0;
            }
            delay[head] = input[i];
            counter++;

            if (counter >= factor) {
                counter = 0;
                // FIR sum: y = sum_k coeffs[k] * x[n-k]
                // x[n-k] = delay[(head - k + N) % N]. Walk backward from head,
                // wrapping at zero.
                let sum = 0;
                let idx = head;
                for (let k = 0; k < N; k++) {
                    sum += coeffs[k] * delay[idx];
                    idx = idx - 1;
                    if (idx < 0) {
                        idx = N - 1;
                    }
                }
                output[outIdx++] = sum;
            }
        }

        this.delayHead = head;
        this.inputsSinceOutput = counter;

        return outIdx;
    }

    public reset(): void {
        this.delay.fill(0);
        this.delayHead = 0;
        this.inputsSinceOutput = 0;
    }

    // Expose taps for testing.
    public getCoefficients(): Float32Array {
        return this.coeffs;
    }
}

// Hamming-windowed sinc low-pass design. Coefficients are normalized so
// the DC gain is unity (sum of coefficients = 1).
function designWindowedSinc(tapCount: number, cutoffHz: number, sampleRate: number): Float32Array {
    if (cutoffHz <= 0 || cutoffHz >= sampleRate / 2) {
        throw new Error(`Decimator: cutoff ${cutoffHz} Hz must be in (0, ${sampleRate / 2}) Hz`);
    }
    const coeffs = new Float32Array(tapCount);
    const wc = 2 * Math.PI * cutoffHz / sampleRate;
    const center = (tapCount - 1) / 2;
    for (let n = 0; n < tapCount; n++) {
        const k = n - center;
        const sinc = k === 0 ? wc / Math.PI : Math.sin(wc * k) / (Math.PI * k);
        // Hamming window: 0.54 - 0.46 * cos(2*pi*n / (N-1))
        const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (tapCount - 1));
        coeffs[n] = sinc * window;
    }
    let sum = 0;
    for (let i = 0; i < tapCount; i++) {
        sum += coeffs[i];
    }
    for (let i = 0; i < tapCount; i++) {
        coeffs[i] /= sum;
    }

    return coeffs;
}
