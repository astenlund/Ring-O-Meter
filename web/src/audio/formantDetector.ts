// Speech-LPC formant detector. Pipeline per analysis frame:
//   1. Pre-emphasis (one-tap high-pass) lifts the source spectrum
//      so LPC fits high formants without low-frequency bias.
//   2. Decimate to a target rate (~8 or 12 kHz) so LPC at a
//      conventional order (~10-14) can resolve formants up to the
//      new Nyquist without wasting resolution above the speech band.
//   3. Hamming window the decimated frame (autocorrelation method)
//      OR pass-through (Burg method).
//   4. LPC fit at the configured order.
//   5. Find roots of the LPC polynomial.
//   6. Convert each conjugate-pair root to (frequency, bandwidth) in
//      the decimated rate's frequency domain. Filter out roots that
//      are real, outside the formant frequency band, or have wide
//      bandwidth (those are typically not formants but spectral
//      smoothing artefacts).
//   7. Sort the kept formants by frequency, return the first N.
//
// Stateful per instance because pre-emphasis and the decimator carry
// state across frames; the LPC fit and root-finding are stateless
// per frame but their workspaces are pre-allocated to keep the
// per-frame call zero-alloc in steady state.

import {Decimator} from './decimator';
import {LpcAutocorrelation, LpcBurg, type LpcOutput} from './lpc';
import {PolyRoots, factorToPole} from './polyRoots';
import {PreEmphasis} from './preEmphasis';

export type LpcMethod = 'autocorrelation' | 'burg';

export interface FormantDetectorSpec {
    inputRate: number;
    decimatedRate: number;
    decimatorCutoffHz: number;
    lpcOrder: number;
    lpcMethod: LpcMethod;
    formantCount: number; // how many formants to surface (e.g., 2 or 4)
    // Filtering thresholds for which LPC roots count as formants.
    minFormantHz?: number;     // default 50: discards low-frequency artefact roots
    maxFormantBandwidthHz?: number; // default 600: anything wider is not a formant
}

// heuristic: min-formant-hz - lower bound on what counts as a formant; LPC
// roots below this frequency are discarded as low-frequency spectral-shape
// artefacts. Tightening drops near-DC artefacts faster; loosening admits
// roots near the lower edge of the formant range (F1 can sit ~150-200 Hz
// for low male vowels, so this floor must stay well below that).
const DEFAULT_MIN_FORMANT_HZ = 50;
// heuristic: max-formant-bandwidth-hz - upper bound on root bandwidth for
// inclusion as a formant; wide-bandwidth roots are typically spectral-
// smoothing or LPC over-fit artefacts rather than real formants. Praat's
// default uses ~400 Hz for the same reason; this is the load-bearing
// detection tiebreak that decides whether a true formant or a spurious
// wide-band root takes a slot in the top-N output. Empirically validated
// during the spike that 600 Hz let spurious roots crowd out true F2.
const DEFAULT_MAX_FORMANT_BW_HZ = 400;

export interface FormantResult {
    frequencies: Float32Array; // length = formantCount, NaN for missing
    bandwidths: Float32Array;  // length = formantCount, NaN for missing
}

export class FormantDetector {
    public readonly spec: FormantDetectorSpec;
    private readonly preEmphasis: PreEmphasis;
    private readonly decimator: Decimator;
    private readonly decimatedScratch: Float32Array;
    private readonly windowedScratch: Float32Array;
    private readonly hammingWindow: Float32Array;
    private readonly lpc: LpcOutput & { compute(samples: Float32Array): void };
    private readonly poly: PolyRoots;
    // Output buffers (mutated per frame).
    public readonly result: FormantResult;
    // Scratch for sorting candidate formants.
    private readonly candidateFreq: Float32Array;
    private readonly candidateBw: Float32Array;
    // Pre-allocated array sized to LPC order + 1; the LPC class returns
    // Float32 coefficients which we hand to PolyRoots verbatim.
    public constructor(spec: FormantDetectorSpec) {
        validateSpec(spec);
        this.spec = spec;

        this.preEmphasis = new PreEmphasis();
        this.decimator = new Decimator({
            inputRate: spec.inputRate,
            outputRate: spec.decimatedRate,
            cutoffHz: spec.decimatorCutoffHz,
        });
        // Decimated scratch sized for one input frame's worth of decimated
        // output. The worklet's input frame is FRAME_SIZE samples; the
        // decimator writes ceil(FRAME_SIZE / decimationFactor) samples.
        // Caller passes a buffer whose decimated length matches this.
        // Allocate generously: 4 * input rate / decimated rate samples to
        // accommodate the largest reasonable input frame.
        const decimatedCapacity = Math.ceil(8192 / this.decimator.decimationFactor);
        this.decimatedScratch = new Float32Array(decimatedCapacity);
        this.windowedScratch = new Float32Array(decimatedCapacity);
        this.hammingWindow = new Float32Array(decimatedCapacity);

        if (spec.lpcMethod === 'autocorrelation') {
            this.lpc = new LpcAutocorrelation(spec.lpcOrder);
        }
        else {
            this.lpc = new LpcBurg(spec.lpcOrder, decimatedCapacity);
        }
        this.poly = new PolyRoots(spec.lpcOrder);

        this.result = {
            frequencies: new Float32Array(spec.formantCount),
            bandwidths: new Float32Array(spec.formantCount),
        };
        this.candidateFreq = new Float32Array(spec.lpcOrder);
        this.candidateBw = new Float32Array(spec.lpcOrder);
    }

    // Process one input frame. Mutates `this.result.frequencies` and
    // `this.result.bandwidths` in place. Returns void; read the result
    // off the public field. NaN entries indicate "fewer than formantCount
    // formants found" - the gate predicate (shouldDisplayFormants on the
    // consumer side) decides what to do with sparse/empty results.
    public process(input: Float32Array): void {
        // Pre-emphasis in place into windowedScratch (we'll overwrite it
        // with decimated samples next; using two buffers avoids needing a
        // third).
        this.preEmphasis.apply(input, this.windowedScratch.subarray(0, input.length));

        // Decimate.
        const decimatedLen = this.decimator.process(
            this.windowedScratch.subarray(0, input.length),
            this.decimatedScratch,
        );
        if (decimatedLen < this.spec.lpcOrder + 1) {
            // Not enough samples yet (decimator priming): null result.
            this.result.frequencies.fill(Number.NaN);
            this.result.bandwidths.fill(Number.NaN);

            return;
        }

        // Window for autocorrelation; pass through for Burg.
        let lpcInput: Float32Array;
        if (this.spec.lpcMethod === 'autocorrelation') {
            this.ensureHammingWindow(decimatedLen);
            for (let i = 0; i < decimatedLen; i++) {
                this.windowedScratch[i] = this.decimatedScratch[i] * this.hammingWindow[i];
            }
            lpcInput = this.windowedScratch.subarray(0, decimatedLen);
        }
        else {
            lpcInput = this.decimatedScratch.subarray(0, decimatedLen);
        }

        // LPC fit.
        this.lpc.compute(lpcInput);

        // Root-find on the LPC polynomial. Coefficients are already in
        // descending-power form for z^p * A(z) (a[0] = 1 is the leading
        // coefficient of the monic polynomial).
        this.poly.compute(this.lpc.coefficients);

        // Convert factors to formant candidates.
        const minHz = this.spec.minFormantHz ?? DEFAULT_MIN_FORMANT_HZ;
        const maxBw = this.spec.maxFormantBandwidthHz ?? DEFAULT_MAX_FORMANT_BW_HZ;
        const fs = this.spec.decimatedRate;
        let candidateCount = 0;
        for (let i = 0; i < this.poly.factorCount; i++) {
            const f = this.poly.getFactor(i);
            const pole = factorToPole(f.u, f.v);
            if (!pole.isComplex) {
                continue;
            }
            // Frequency = fs * angle / (2 pi); bandwidth = -fs * ln(r) / pi.
            const freq = fs * pole.angle / (2 * Math.PI);
            const bw = -fs * Math.log(pole.magnitude) / Math.PI;
            if (freq < minHz || freq >= fs / 2) {
                continue;
            }
            if (bw <= 0 || bw > maxBw) {
                continue;
            }
            this.candidateFreq[candidateCount] = freq;
            this.candidateBw[candidateCount] = bw;
            candidateCount++;
        }

        // Sort by frequency ascending using insertion sort. With at most
        // p/2 candidates (~5-7), insertion sort beats any general-purpose
        // sort for both code size and constant factor.
        for (let i = 1; i < candidateCount; i++) {
            const f = this.candidateFreq[i];
            const b = this.candidateBw[i];
            let j = i - 1;
            while (j >= 0 && this.candidateFreq[j] > f) {
                this.candidateFreq[j + 1] = this.candidateFreq[j];
                this.candidateBw[j + 1] = this.candidateBw[j];
                j--;
            }
            this.candidateFreq[j + 1] = f;
            this.candidateBw[j + 1] = b;
        }

        const target = this.spec.formantCount;
        for (let i = 0; i < target; i++) {
            if (i < candidateCount) {
                this.result.frequencies[i] = this.candidateFreq[i];
                this.result.bandwidths[i] = this.candidateBw[i];
            }
            else {
                this.result.frequencies[i] = Number.NaN;
                this.result.bandwidths[i] = Number.NaN;
            }
        }
    }

    public reset(): void {
        this.preEmphasis.reset();
        this.decimator.reset();
    }

    private ensureHammingWindow(length: number): void {
        // Cache by length: the worklet calls this with the same length
        // every frame, so the window is computed once on first use.
        if (this.hammingWindow[0] !== 0 && this.hammingWindow.length >= length) {
            // Already populated and the per-frame length matches the
            // pre-computed span. Quick check: if the last expected sample
            // is non-zero (the window's first and last samples are 0.08
            // for Hamming, not 0), then we have a populated window. If
            // it was computed for a different length, the sample at
            // position `length - 1` would not be ~0.08.
            const expectedTail = 0.54 - 0.46 * Math.cos(2 * Math.PI * (length - 1) / (length - 1));
            const tail = this.hammingWindow[length - 1];
            if (Math.abs(tail - expectedTail) < 1e-6) {
                return;
            }
        }
        for (let n = 0; n < length; n++) {
            this.hammingWindow[n] = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (length - 1));
        }
    }
}

function validateSpec(spec: FormantDetectorSpec): void {
    if (spec.lpcOrder < 2) {
        throw new Error(`FormantDetector: lpcOrder must be >= 2, got ${spec.lpcOrder}`);
    }
    if (spec.formantCount < 1) {
        throw new Error(`FormantDetector: formantCount must be >= 1, got ${spec.formantCount}`);
    }
    if (!Number.isInteger(spec.inputRate / spec.decimatedRate)) {
        throw new Error(
            `FormantDetector: inputRate ${spec.inputRate} must be an integer multiple of decimatedRate ${spec.decimatedRate}`,
        );
    }
    if (spec.decimatorCutoffHz <= 0 || spec.decimatorCutoffHz >= spec.decimatedRate / 2) {
        throw new Error(
            `FormantDetector: decimatorCutoffHz ${spec.decimatorCutoffHz} must be in (0, ${spec.decimatedRate / 2})`,
        );
    }
}
