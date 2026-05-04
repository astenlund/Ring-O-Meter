// Linear Predictive Coding via two algorithms: autocorrelation +
// Levinson-Durbin (faster, can produce unstable filters on transients)
// and Burg (slower, always produces stable filters from finite data).
// Both produce the same output shape: predictor coefficients
// a[0..p] (with a[0] = 1), reflection coefficients k[1..p], and
// final prediction error energy.
//
// LPC models the input as the output of an all-pole filter
// 1 / A(z) where A(z) = 1 + a[1] z^-1 + ... + a[p] z^-p driven by
// white noise. The roots of A(z) lie near the resonant frequencies
// of the modeled signal - for voiced speech, those are the formants.
// Downstream code finds A(z)'s roots and converts to formant
// frequency + bandwidth.
//
// Per-instance workspace; not thread-safe. Each call to compute()
// overwrites the public fields. Both classes expose the same output
// shape so the formant-extraction stage is algorithm-agnostic.

export interface LpcOutput {
    readonly order: number;
    readonly coefficients: Float32Array; // length = order + 1, coefficients[0] = 1
    readonly reflections: Float32Array;  // length = order
    readonly error: number;              // residual prediction error energy
}

// Autocorrelation method: estimate R[0..p], solve the Toeplitz system
// via Levinson-Durbin recursion. Input should be windowed (Hamming
// typical) to suppress edge artefacts that bias the autocorrelation.
export class LpcAutocorrelation implements LpcOutput {
    public readonly order: number;
    public readonly coefficients: Float32Array;
    public readonly reflections: Float32Array;
    public error = 0;
    private readonly autocorr: Float32Array;
    private readonly prevCoeffs: Float32Array;

    public constructor(order: number) {
        if (order < 1) {
            throw new Error(`LpcAutocorrelation: order must be >= 1, got ${order}`);
        }
        this.order = order;
        this.coefficients = new Float32Array(order + 1);
        this.reflections = new Float32Array(order);
        this.autocorr = new Float32Array(order + 1);
        this.prevCoeffs = new Float32Array(order + 1);
    }

    public compute(windowedSamples: Float32Array): void {
        const p = this.order;
        const N = windowedSamples.length;
        const R = this.autocorr;
        const a = this.coefficients;
        const aPrev = this.prevCoeffs;
        const k = this.reflections;

        // Autocorrelation: R[m] = sum_{n=0}^{N-1-m} x[n] * x[n+m] for m = 0..p.
        for (let m = 0; m <= p; m++) {
            let sum = 0;
            for (let n = 0; n < N - m; n++) {
                sum += windowedSamples[n] * windowedSamples[n + m];
            }
            R[m] = sum;
        }

        // Degenerate input: zero-energy frame yields R[0] = 0. Return all-zero
        // coefficients with a[0] = 1 so downstream code treats this as a
        // null fit rather than dividing by zero.
        if (R[0] === 0) {
            a.fill(0);
            a[0] = 1;
            k.fill(0);
            this.error = 0;

            return;
        }

        // Levinson-Durbin recursion. Standard form: at iteration i, a holds
        // the order-i coefficients with a[0] = 1. aPrev caches the order-(i-1)
        // coefficients needed by the symmetric update.
        a.fill(0);
        a[0] = 1;
        let E = R[0];
        for (let i = 1; i <= p; i++) {
            // Reflection coefficient.
            let acc = R[i];
            for (let j = 1; j < i; j++) {
                acc += a[j] * R[i - j];
            }
            const ki = -acc / E;
            k[i - 1] = ki;

            // Snapshot a[1..i-1] so the symmetric update reads the
            // previous-iteration values consistently.
            for (let j = 1; j < i; j++) {
                aPrev[j] = a[j];
            }
            a[i] = ki;
            for (let j = 1; j < i; j++) {
                a[j] = aPrev[j] + ki * aPrev[i - j];
            }
            E *= (1 - ki * ki);
            if (E <= 0) {
                // Numerical breakdown (shouldn't happen on valid input but
                // guard anyway). Stop recursion; remaining coefficients stay 0.
                this.error = 0;

                return;
            }
        }
        this.error = E;
    }
}

// Burg method: minimize the sum of forward and backward prediction errors
// at each order, accumulating reflection coefficients without computing
// the autocorrelation. Always produces a stable filter (all roots inside
// the unit circle) from finite-length data, which is why speech-LPC
// references prefer it for short windows or transient-heavy material.
// Slightly more compute than autocorrelation: O(N*p) per order vs O(p^2)
// for Levinson-Durbin (after the O(N*p) autocorrelation).
export class LpcBurg implements LpcOutput {
    public readonly order: number;
    public readonly coefficients: Float32Array;
    public readonly reflections: Float32Array;
    public error = 0;
    private forwardError: Float32Array;
    private backwardError: Float32Array;
    private readonly prevCoeffs: Float32Array;
    private capacity = 0;

    public constructor(order: number, expectedFrameSize = 0) {
        if (order < 1) {
            throw new Error(`LpcBurg: order must be >= 1, got ${order}`);
        }
        this.order = order;
        this.coefficients = new Float32Array(order + 1);
        this.reflections = new Float32Array(order);
        this.prevCoeffs = new Float32Array(order + 1);
        // Forward/backward error buffers grow on demand; pre-size if caller
        // knows the typical input length to avoid the first-call allocation.
        this.forwardError = new Float32Array(expectedFrameSize);
        this.backwardError = new Float32Array(expectedFrameSize);
        this.capacity = expectedFrameSize;
    }

    public compute(samples: Float32Array): void {
        const p = this.order;
        const N = samples.length;
        const a = this.coefficients;
        const aPrev = this.prevCoeffs;
        const k = this.reflections;

        if (N < p + 1) {
            throw new Error(`LpcBurg.compute: input length ${N} too short for order ${p}`);
        }

        let f = this.forwardError;
        let b = this.backwardError;
        if (this.capacity < N) {
            f = new Float32Array(N);
            b = new Float32Array(N);
            this.forwardError = f;
            this.backwardError = b;
            this.capacity = N;
        }

        // Initialise f and b from the input.
        let energy = 0;
        for (let n = 0; n < N; n++) {
            const x = samples[n];
            f[n] = x;
            b[n] = x;
            energy += x * x;
        }

        if (energy === 0) {
            a.fill(0);
            a[0] = 1;
            k.fill(0);
            this.error = 0;

            return;
        }

        a.fill(0);
        a[0] = 1;
        let E = energy / N;

        for (let i = 1; i <= p; i++) {
            // Reflection coefficient: k = -2 * sum(f[n]*b[n-1]) / sum(f[n]^2 + b[n-1]^2)
            // for n = i..N-1.
            let num = 0;
            let den = 0;
            for (let n = i; n < N; n++) {
                const fn = f[n];
                const bn = b[n - 1];
                num += fn * bn;
                den += fn * fn + bn * bn;
            }
            if (den === 0) {
                // Degenerate; remaining reflections stay 0.
                this.error = E;

                return;
            }
            const ki = -2 * num / den;
            k[i - 1] = ki;

            // Update f and b. Iterate from high to low so we can reuse the
            // arrays (each update reads f[n], b[n-1] and writes f[n], b[n]).
            // Walking high-to-low lets b[n] = b[n-1] + ki * f[n] use the
            // pre-update b[n-1] before it is overwritten by the next iteration.
            for (let n = N - 1; n >= i; n--) {
                const fn = f[n];
                const bn = b[n - 1];
                f[n] = fn + ki * bn;
                b[n] = bn + ki * fn;
            }

            // Update LPC coefficients via Levinson-style symmetric update.
            for (let j = 1; j < i; j++) {
                aPrev[j] = a[j];
            }
            a[i] = ki;
            for (let j = 1; j < i; j++) {
                a[j] = aPrev[j] + ki * aPrev[i - j];
            }

            E *= (1 - ki * ki);
        }
        this.error = E;
    }
}
