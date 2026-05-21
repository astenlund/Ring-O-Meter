// Test-only AudioWorkletProcessor that fans one captured signal out to
// N SAB rings, with per-ring pitch offsets so the N traces remain
// visually distinguishable on the plot. Identical DSP to
// pitchWorklet.ts (one detectPitch + one OctaveStabilizer per
// process()), then loops N writers publishing the same frame with
// fundamentalHz and fundamentalHzRaw multiplied by the channel's
// pitch multiplier. Constructed only when ?fanout=N is set; the
// production worklet (pitchWorklet.ts) is unchanged.
//
// Rationale: isolates rendering-load scaling (4 SAB rings, 4 plot
// traces, 4 NoteReadouts) from DSP-load scaling (still 1 detectPitch
// per quantum). The BUGS.md trio (paint freezes, snap-backs, judder)
// is compositor/GPU-process territory, separate from the audio thread,
// so this fanout faithfully reproduces the rendering load that real
// 4-mic capture would create on iPad while keeping DSP cost low.
//
// Permanent dev-mode infrastructure; gated by devModesEnabled in /config.json.

import {detectPitch} from '../dsp/pitchDetector';
import {computeRmsDb} from '../dsp/rmsDb';
import {OctaveStabilizer} from '../dsp/octaveStabilizer';
import {ANALYSIS_WINDOW_SIZE, FRAME_SIZE, PROCESSOR_ERROR_TYPE} from '../audio/constants';
import {FORMANT_ABSENT_SENTINEL, FrameRingWriter, SAB_FORMANT_COLUMN_COUNT, type PublishFrame} from '../audio/frameRing';
import {PITCH_FANOUT_PROCESSOR_NAME} from './fanoutConstants';
import {DEFAULT_FORMANT_SPEC, FormantDetector, adaptDecimatedRate} from '../dsp/formantDetector';

const PUBLISH_INTERVAL_FRAMES = 1;

interface FanoutProcessorOptions {
    frameRingSabs?: SharedArrayBuffer[];
    pitchMultipliers?: number[];
}

class FanoutPitchProcessor extends AudioWorkletProcessor {
    private readonly buffer = new Float32Array(ANALYSIS_WINDOW_SIZE);
    private readonly latestFrame = this.buffer.subarray(FRAME_SIZE, ANALYSIS_WINDOW_SIZE);
    private blocksAccumulated = 0;
    private bufferIndex = FRAME_SIZE;
    private framesSinceLastPublish = 0;
    private readonly writers: FrameRingWriter[];
    private readonly multipliers: readonly number[];
    private readonly stabilizer = new OctaveStabilizer();
    private readonly formantDetector: FormantDetector;
    // One scratch struct mutated in place across publish() iterations
    // and across writers, mirroring the zero-alloc pattern documented
    // in pitchWorklet.ts.
    private readonly scratch: PublishFrame = {
        captureContextMs: 0,
        fundamentalHz: 0,
        confidence: 0,
        rmsDb: 0,
        fundamentalHzRaw: 0,
        f1Hz: 0,
        f2Hz: 0,
        f3Hz: 0,
        f4Hz: 0,
    };

    public constructor(options?: AudioWorkletNodeOptions) {
        super();
        try {
            const opts = (options?.processorOptions ?? {}) as FanoutProcessorOptions;
            const sabs = opts.frameRingSabs;
            const multipliers = opts.pitchMultipliers;
            if (!sabs || !multipliers) {
                throw new Error(
                    'FanoutPitchProcessor: processorOptions.frameRingSabs and pitchMultipliers are required',
                );
            }
            if (sabs.length !== multipliers.length) {
                throw new Error(
                    'FanoutPitchProcessor: frameRingSabs and pitchMultipliers must have equal length',
                );
            }
            if (sabs.length === 0) {
                throw new Error('FanoutPitchProcessor: at least one ring is required');
            }
            this.writers = sabs.map((s) => new FrameRingWriter(s));
            this.multipliers = multipliers;
            // Adaptive decimatedRate so the worklet stays alive on
            // hosts whose negotiated sampleRate is not a multiple of
            // DEFAULT_FORMANT_SPEC.decimatedRate (e.g. 44100 on
            // macOS/iOS); see pitchWorklet.ts for full rationale. The
            // structured port-message + console.error fallback below
            // remains as belt-and-braces for any other construction
            // failure.
            const decimatedRate = adaptDecimatedRate(sampleRate, DEFAULT_FORMANT_SPEC.decimatedRate);
            this.formantDetector = new FormantDetector({
                ...DEFAULT_FORMANT_SPEC,
                inputRate: sampleRate,
                decimatedRate,
            });
            // Same SAB schema constraint as pitchWorklet.ts: publish()
            // hardcodes formants[0..N-1] -> f1Hz..fNHz.
            if (this.formantDetector.spec.formantCount !== SAB_FORMANT_COLUMN_COUNT) {
                throw new Error(
                    `fanoutWorklet: formantCount must be ${SAB_FORMANT_COLUMN_COUNT} to match the SAB ring schema (got ${this.formantDetector.spec.formantCount})`,
                );
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('FanoutPitchProcessor: construction failed', message);
            this.port.postMessage({type: PROCESSOR_ERROR_TYPE, message});
            throw err;
        }
    }

    public process(
        inputs: Float32Array[][],
        _outputs: Float32Array[][],
    ): boolean {
        const channel = inputs[0]?.[0];
        if (!channel) {
            return true;
        }

        let inputOffset = 0;
        let remaining = channel.length;
        while (remaining > 0) {
            const space = ANALYSIS_WINDOW_SIZE - this.bufferIndex;
            const chunk = remaining < space ? remaining : space;
            this.buffer.set(channel.subarray(inputOffset, inputOffset + chunk), this.bufferIndex);
            this.bufferIndex += chunk;
            inputOffset += chunk;
            remaining -= chunk;
            if (this.bufferIndex >= ANALYSIS_WINDOW_SIZE) {
                this.blocksAccumulated++;
                if (this.blocksAccumulated >= 2) {
                    this.framesSinceLastPublish++;
                    if (this.framesSinceLastPublish >= PUBLISH_INTERVAL_FRAMES) {
                        this.publish();
                        this.framesSinceLastPublish = 0;
                    }
                }
                this.buffer.copyWithin(0, FRAME_SIZE, ANALYSIS_WINDOW_SIZE);
                this.bufferIndex = FRAME_SIZE;
            }
        }

        return true;
    }

    private publish(): void {
        const result = detectPitch(this.buffer, sampleRate);
        if (!Number.isFinite(result.fundamentalHz)) {
            return;
        }
        const rmsDb = computeRmsDb(this.latestFrame);
        const fundamentalHzRaw = result.fundamentalHz;
        const stabilized = this.stabilizer.apply(fundamentalHzRaw);
        // Fields shared across all N writers: captured once before the
        // fan-out loop. Hz fields are per-writer so they're set inside
        // the loop.
        this.scratch.captureContextMs = currentTime * 1000;
        this.scratch.confidence = result.confidence;
        this.scratch.rmsDb = rmsDb;

        // Formants computed ONCE before the fan-out loop: all N rings
        // share one mic input (same vocal tract), so formants are
        // identical across rings. Computing per-ring would be wasteful
        // and still produce the same values.
        this.formantDetector.process(this.latestFrame);
        const formants = this.formantDetector.result.frequencies;
        this.scratch.f1Hz = Number.isFinite(formants[0]) ? formants[0] : FORMANT_ABSENT_SENTINEL;
        this.scratch.f2Hz = Number.isFinite(formants[1]) ? formants[1] : FORMANT_ABSENT_SENTINEL;
        this.scratch.f3Hz = Number.isFinite(formants[2]) ? formants[2] : FORMANT_ABSENT_SENTINEL;
        this.scratch.f4Hz = Number.isFinite(formants[3]) ? formants[3] : FORMANT_ABSENT_SENTINEL;

        for (let i = 0; i < this.writers.length; i++) {
            const m = this.multipliers[i];
            this.scratch.fundamentalHz = stabilized.hz * m;
            this.scratch.fundamentalHzRaw = fundamentalHzRaw * m;
            this.writers[i].publish(this.scratch);
        }
    }
}

registerProcessor(PITCH_FANOUT_PROCESSOR_NAME, FanoutPitchProcessor);
