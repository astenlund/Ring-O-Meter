// AudioWorklet shell. The DSP lives in the testable pitchDetector and
// rmsDb modules; OctaveStabilizer and the SAB writer live alongside
// because per-frame data leaves the audio thread via the ring rather
// than via port.postMessage. The stabilized value is what reaches the
// ring, which is what every consumer (NoteReadout, plot worker) reads.

import {detectPitch} from '../pitchDetector';
import {computeRmsDb} from '../rmsDb';
import {OctaveStabilizer} from '../octaveStabilizer';
import {ANALYSIS_WINDOW_SIZE, FRAME_SIZE, PITCH_PROCESSOR_NAME} from '../constants';
import {FrameRingWriter, SAB_FORMANT_COLUMN_COUNT, type PublishFrame} from '../frameRing';
import {DEFAULT_FORMANT_SPEC, FormantDetector} from '../formantDetector';

const PUBLISH_INTERVAL_FRAMES = 1; // every ~21 ms at 48 kHz -> ~47 Hz publish

interface PitchProcessorOptions {
    frameRingSab?: SharedArrayBuffer;
}

class PitchProcessor extends AudioWorkletProcessor {
    // Rolling 2048-sample window: positions [0, FRAME_SIZE) hold the
    // previous frame, [FRAME_SIZE, ANALYSIS_WINDOW_SIZE) accumulate the
    // current frame. After each publish, the latter half shifts to the
    // former half so the next publish sees both the new latest 1024 and
    // the previous 1024 as YIN history.
    private readonly buffer = new Float32Array(ANALYSIS_WINDOW_SIZE);
    // View over the latest FRAME_SIZE samples (the latter half). Created
    // once and reused; subarray returns a view onto the same backing
    // buffer, so RMS + formants always see the just-filled window
    // without re-allocation per publish.
    private readonly latestFrame = this.buffer.subarray(FRAME_SIZE, ANALYSIS_WINDOW_SIZE);
    // Tracks how many FRAME_SIZE blocks have landed since startup. The
    // first block leaves zeros in [0, FRAME_SIZE); publishing then would
    // have YIN fit an autocorrelation lag at the silence/audio
    // discontinuity, returning a spurious low frequency. Skip the first
    // publish so YIN only ever sees two real frames of audio.
    private blocksAccumulated = 0;
    private bufferIndex = FRAME_SIZE;
    private framesSinceLastPublish = 0;
    private readonly writer: FrameRingWriter;
    private readonly stabilizer = new OctaveStabilizer();
    private readonly formantDetector: FormantDetector;
    // Hoisted scratch reused across every publish so the hot-path
    // stays zero-alloc; the writer reads the fields and copies them
    // into the SAB ring slot. Mutated in place inside publish().
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
        const opts = (options?.processorOptions ?? {}) as PitchProcessorOptions;
        if (!opts.frameRingSab) {
            throw new Error('PitchProcessor: processorOptions.frameRingSab is required');
        }
        this.writer = new FrameRingWriter(opts.frameRingSab);
        this.formantDetector = new FormantDetector({
            ...DEFAULT_FORMANT_SPEC,
            inputRate: sampleRate,
        });
        // The publish() loop below hardcodes formants[0..N-1] -> f1Hz..fNHz.
        // SAB_FORMANT_COLUMN_COUNT is the schema authority; bind the
        // assertion to it so a future ring-schema change (the only
        // place the column count actually lives) is the single edit
        // that this guard tracks. A tuning of DEFAULT_FORMANT_SPEC
        // alone cannot silently zero-pad or drop slots.
        if (this.formantDetector.spec.formantCount !== SAB_FORMANT_COLUMN_COUNT) {
            throw new Error(
                `pitchWorklet: formantCount must be ${SAB_FORMANT_COLUMN_COUNT} to match the SAB ring schema (got ${this.formantDetector.spec.formantCount})`,
            );
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

        // Batch-copy the render quantum (typically 128 samples) into the
        // ring buffer with TypedArray.set, which compiles to a
        // memcpy-class path. The former per-sample loop ran ~128 branches
        // per quantum on the audio thread; this keeps the same logical
        // behaviour (publish when the latter half fills) at a fraction
        // of the per-sample overhead.
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
                // Shift the latter half to the former half so the NEXT
                // FRAME_SIZE of input lands behind it, keeping the YIN
                // window 50%-overlapped with the previous publish. Uses
                // copyWithin for an in-place memmove; no allocation.
                this.buffer.copyWithin(0, FRAME_SIZE, ANALYSIS_WINDOW_SIZE);
                this.bufferIndex = FRAME_SIZE;
            }
        }

        return true;
    }

    private publish(): void {
        // YIN sees the full 2048-sample window for low-frequency reach
        // down to ~47 Hz (well below C2 = 65.4 Hz).
        const result = detectPitch(this.buffer, sampleRate);
        if (!Number.isFinite(result.fundamentalHz)) {
            // Defensive: pitchDetector may emit 0 for "no pitch"
            // (finite). NaN/Infinity indicates an upstream bug; drop
            // the frame so no corrupted value enters the ring.
            return;
        }
        // RMS is point-in-time loudness; the latest 1024 is what the
        // user is currently producing. Averaging over 2048 would smear
        // attack transients across the window's first half.
        const rmsDb = computeRmsDb(this.latestFrame);
        // Capture the verbatim YIN reading: stabilizer.apply() returns
        // only the (possibly corrected) hz, not the input, so the raw
        // must be bound here. Preserved on the wire as fundamentalHzRaw
        // so future tooling can audit octave corrections after the fact.
        const fundamentalHzRaw = result.fundamentalHz;
        const stabilized = this.stabilizer.apply(fundamentalHzRaw);

        // Formants alongside pitch. Pre-emphasis + decimation carry
        // filter state across frames, so feeding the latest 1024 keeps
        // the analysis aligned with the publish cadence. Detector
        // mutates its public `result.frequencies` field in place; copy
        // values out before calling writer.publish() since the writer
        // captures by value.
        this.formantDetector.process(this.latestFrame);
        const formants = this.formantDetector.result.frequencies;

        // currentTime is AudioContext seconds; multiply by 1000 for
        // ms matching the ring's contextMs field semantics. Readers
        // (main + worker) convert to paint epoch via their offset.
        this.scratch.captureContextMs = currentTime * 1000;
        this.scratch.fundamentalHz = stabilized.hz;
        this.scratch.confidence = result.confidence;
        this.scratch.rmsDb = rmsDb;
        this.scratch.fundamentalHzRaw = fundamentalHzRaw;
        // Map detector NaN to 0 for SAB transit. Float32 NaN survives
        // memory stores, but downstream consumers (TS gates, the polygon
        // module's gating debounce) treat 0 as the "no formant in slot"
        // sentinel; 0-as-sentinel keeps the contract uniform with the
        // writer's existing "fundamentalHz === 0 means no pitch" idiom.
        this.scratch.f1Hz = Number.isFinite(formants[0]) ? formants[0] : 0;
        this.scratch.f2Hz = Number.isFinite(formants[1]) ? formants[1] : 0;
        this.scratch.f3Hz = Number.isFinite(formants[2]) ? formants[2] : 0;
        this.scratch.f4Hz = Number.isFinite(formants[3]) ? formants[3] : 0;
        this.writer.publish(this.scratch);
    }
}

registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
