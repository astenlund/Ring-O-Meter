// Pre-emphasis high-pass filter: y[n] = x[n] - alpha * x[n-1].
//
// Voiced speech has a natural ~-6 dB/octave spectral tilt from the
// glottal source plus radiation impedance. LPC fits the strongest
// energy in the spectrum; without pre-emphasis the fit is biased
// toward low-frequency energy and under-resolves higher formants
// (F3, F4 in particular). A one-tap high-pass at alpha ~0.97 lifts
// the spectrum by ~6 dB/octave above ~150 Hz, evening out the
// energy distribution before LPC analysis. Standard practice for
// speech LPC; the coefficient is an engineering constant, not a
// coaching tunable.
//
// Stateful per instance; not thread-safe. Carries the last input
// sample across frames so the filter is continuous across the
// worklet's frame boundaries (the alternative - reset per frame -
// produces a transient at every frame edge).

export const PRE_EMPHASIS_ALPHA = 0.97;

export class PreEmphasis {
    private prev = 0;
    private readonly alpha: number;

    public constructor(alpha: number = PRE_EMPHASIS_ALPHA) {
        this.alpha = alpha;
    }

    // Apply in place: out[n] = in[n] - alpha * prev, where prev is
    // the previous input sample (carried across calls). out and in
    // may alias; the loop reads in[i] before writing out[i].
    public apply(input: Float32Array, output: Float32Array): void {
        if (output.length < input.length) {
            throw new Error(`PreEmphasis.apply: output length ${output.length} < input length ${input.length}`);
        }

        let prev = this.prev;
        const alpha = this.alpha;
        for (let i = 0; i < input.length; i++) {
            const x = input[i];
            output[i] = x - alpha * prev;
            prev = x;
        }
        this.prev = prev;
    }

    public reset(): void {
        this.prev = 0;
    }
}
