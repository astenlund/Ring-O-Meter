// Speech-LPC formant detector. Pipeline per analysis frame:
//   1. Pre-emphasis (one-tap high-pass) lifts the source spectrum
//      so LPC fits high formants without low-frequency bias.
//   2. Decimate to a target rate (~8 or 12 kHz) so LPC at a
//      conventional order (~10-14) can resolve formants up to the
//      new Nyquist without wasting resolution above the speech band.
//   3. Burg LPC fit at the configured order. Burg minimises forward
//      and backward prediction error directly on the unwindowed
//      decimated samples; no Hamming windowing step. Burg was chosen
//      over autocorrelation+Levinson after manual triage 2026-05-05
//      showed Burg wins or ties on every vowel tested, with faster
//      onset lock, tighter held-vowel spread, and better breathy-voice
//      survival. See .claude/features/robust-formant-pipeline.md for
//      the higher-order failure mode (harmonic-to-pole binding above
//      f0 ~350 Hz) that motivates the next round of work.
//   4. Find roots of the LPC polynomial.
//   5. Convert each conjugate-pair root to (frequency, bandwidth) in
//      the decimated rate's frequency domain. Filter out roots that
//      are real, outside the formant frequency band, or have wide
//      bandwidth (those are typically not formants but spectral
//      smoothing artefacts).
//   6. Sort the kept formants by frequency, return the first N.
//
// Stateful per instance because pre-emphasis and the decimator carry
// state across frames; the LPC fit and root-finding are stateless
// per frame but their workspaces are pre-allocated to keep the
// per-frame call zero-alloc in steady state.

import {FRAME_SIZE} from './constants';
import {Decimator} from './decimator';
import {LpcBurg} from './lpc';
import {PolyRoots, factorToPole} from './polyRoots';
import {PreEmphasis} from './preEmphasis';

// Upper bound on the input frame size this detector can process. The
// worklet currently calls process() with a 1024-sample view, but the
// scratch buffers carry 8x headroom so a future window-size retune is
// covered without re-tuning every consumer. Bound the propagation to
// FRAME_SIZE so a static change at the source is visible here.
export const MAX_INPUT_FRAME_SIZE = FRAME_SIZE * 8;

export interface FormantDetectorSpec {
    inputRate: number;
    decimatedRate: number;
    decimatorCutoffHz: number;
    lpcOrder: number;
    formantCount: number; // how many formants to surface (e.g., 2 or 4)
    // Filtering thresholds for which LPC roots count as formants.
    minFormantHz?: number;     // default 50: discards low-frequency artefact roots
    maxFormantBandwidthHz?: number; // default 400: anything wider is not a formant
}

// Default `FormantDetectorSpec` values used by both production
// (`pitchWorklet.ts`) and test-mode (`fanoutWorklet.ts`) worklets. A
// future tuning pass to `lpcOrder` or `decimatedRate` should change
// the values here once, not at every call site. `inputRate` stays
// per-call because it is `sampleRate` from the AudioWorkletGlobalScope
// (not knowable at module load).
export const DEFAULT_FORMANT_SPEC: Omit<FormantDetectorSpec, 'inputRate'> = {
    decimatedRate: 12000,
    decimatorCutoffHz: 5500,
    lpcOrder: 14,
    formantCount: 4,
};

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
// wide-band root takes a slot in the top-N output. Settled on 400 after
// the spike found that 600 admitted spurious wide-band roots that
// crowded out true F2.
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
    private readonly preEmphasisScratch: Float32Array;
    private readonly lpc: LpcBurg;
    private readonly poly: PolyRoots;
    // Output buffers (mutated per frame).
    public readonly result: FormantResult;
    // Scratch for sorting candidate formants.
    private readonly candidateFreq: Float32Array;
    private readonly candidateBw: Float32Array;

    public constructor(spec: FormantDetectorSpec) {
        validateSpec(spec);
        this.spec = spec;

        this.preEmphasis = new PreEmphasis();
        this.decimator = new Decimator({
            inputRate: spec.inputRate,
            outputRate: spec.decimatedRate,
            cutoffHz: spec.decimatorCutoffHz,
        });
        // Sized for ceil(MAX_INPUT_FRAME_SIZE / decimationFactor) decimated
        // samples. The worklet's actual input frame is FRAME_SIZE = 1024;
        // MAX_INPUT_FRAME_SIZE = FRAME_SIZE * 8 carries headroom so a
        // future window-size retune is covered without re-tuning here.
        const decimatedCapacity = Math.ceil(MAX_INPUT_FRAME_SIZE / this.decimator.decimationFactor);
        this.decimatedScratch = new Float32Array(decimatedCapacity);
        // Distinct from decimatedScratch: pre-emphasis runs at input rate
        // and writes a same-length buffer that the decimator then reads.
        this.preEmphasisScratch = new Float32Array(MAX_INPUT_FRAME_SIZE);

        this.lpc = new LpcBurg(spec.lpcOrder, decimatedCapacity);
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
        this.preEmphasis.apply(input, this.preEmphasisScratch.subarray(0, input.length));

        const decimatedLen = this.decimator.process(
            this.preEmphasisScratch.subarray(0, input.length),
            this.decimatedScratch,
        );
        if (decimatedLen < this.spec.lpcOrder + 1) {
            // Not enough samples yet (decimator priming): null result.
            this.result.frequencies.fill(Number.NaN);
            this.result.bandwidths.fill(Number.NaN);

            return;
        }

        // Burg LPC fits unwindowed samples directly.
        this.lpc.compute(this.decimatedScratch.subarray(0, decimatedLen));

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
    // An LPC polynomial of order p has at most p/2 conjugate-pair roots,
    // so requesting more formants than possible roots is unfulfillable.
    // Validate at construction so downstream (paint, gating) does not
    // silently see permanently-NaN trailing slots.
    const maxFormants = Math.floor(spec.lpcOrder / 2);
    if (spec.formantCount > maxFormants) {
        throw new Error(
            `FormantDetector: formantCount ${spec.formantCount} exceeds the ${maxFormants} max possible from lpcOrder ${spec.lpcOrder}`,
        );
    }
}
