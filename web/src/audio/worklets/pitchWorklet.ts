// AudioWorklet shell. The DSP lives in the testable pitchDetector and
// rmsDb modules; OctaveStabilizer and the SAB writer live alongside
// because per-frame data leaves the audio thread via the ring rather
// than via port.postMessage. The stabilized value is what reaches the
// ring, which is what every consumer (NoteReadout, plot worker) reads.

import {detectPitch} from '../pitchDetector';
import {computeRmsDb} from '../rmsDb';
import {OctaveStabilizer} from '../octaveStabilizer';
import {PITCH_PROCESSOR_NAME} from '../constants';
import {FrameRingWriter, type PublishFrame} from '../frameRing';
import {FormantDetector, type LpcMethod} from '../formantDetector';

const FRAME_SIZE = 1024;
const PUBLISH_INTERVAL_FRAMES = 1; // every ~21 ms at 48 kHz -> ~47 Hz publish

interface PitchProcessorOptions {
    frameRingSab?: SharedArrayBuffer;
}

class PitchProcessor extends AudioWorkletProcessor {
    private readonly buffer = new Float32Array(FRAME_SIZE);
    private bufferIndex = 0;
    private framesSinceLastPublish = 0;
    private readonly writer: FrameRingWriter;
    private readonly stabilizer = new OctaveStabilizer();
    // Not readonly: handlePortMessage reassigns it on algorithm swap.
    private formantDetector: FormantDetector;
    private currentLpcMethod: LpcMethod = 'burg';
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
        this.formantDetector = this.createFormantDetector(this.currentLpcMethod);
        this.port.onmessage = (event: MessageEvent) => this.handlePortMessage(event.data);
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
        // behaviour (publish when the buffer is full) at a fraction of
        // the per-sample overhead.
        let inputOffset = 0;
        let remaining = channel.length;
        while (remaining > 0) {
            const space = FRAME_SIZE - this.bufferIndex;
            const chunk = remaining < space ? remaining : space;
            this.buffer.set(channel.subarray(inputOffset, inputOffset + chunk), this.bufferIndex);
            this.bufferIndex += chunk;
            inputOffset += chunk;
            remaining -= chunk;
            if (this.bufferIndex >= FRAME_SIZE) {
                this.framesSinceLastPublish++;
                if (this.framesSinceLastPublish >= PUBLISH_INTERVAL_FRAMES) {
                    this.publish();
                    this.framesSinceLastPublish = 0;
                }
                this.bufferIndex = 0;
            }
        }

        return true;
    }

    private publish(): void {
        const result = detectPitch(this.buffer, sampleRate);
        if (!Number.isFinite(result.fundamentalHz)) {
            // Defensive: pitchDetector may emit 0 for "no pitch"
            // (finite). NaN/Infinity indicates an upstream bug; drop
            // the frame so no corrupted value enters the ring.
            return;
        }
        const rmsDb = computeRmsDb(this.buffer);
        // Capture the verbatim YIN reading: stabilizer.apply() returns
        // only the (possibly corrected) hz, not the input, so the raw
        // must be bound here. Preserved on the wire as fundamentalHzRaw
        // so future tooling can audit octave corrections after the fact.
        const fundamentalHzRaw = result.fundamentalHz;
        const stabilized = this.stabilizer.apply(fundamentalHzRaw);

        // Formants alongside pitch. The detector mutates its public
        // `result.frequencies` field in place; copy values out before
        // calling writer.publish() since the writer captures by value.
        this.formantDetector.process(this.buffer);
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

    private createFormantDetector(method: LpcMethod): FormantDetector {
        return new FormantDetector({
            inputRate: sampleRate,
            decimatedRate: 12000,
            decimatorCutoffHz: 5500,
            lpcOrder: 14,
            lpcMethod: method,
            formantCount: 4,
        });
    }

    private handlePortMessage(data: unknown): void {
        if (typeof data !== 'object' || data === null) {
            return;
        }
        const msg = data as {type?: string; method?: LpcMethod};
        if (msg.type === 'setLpcMethod' && (msg.method === 'burg' || msg.method === 'autocorrelation')) {
            this.currentLpcMethod = msg.method;
            this.formantDetector = this.createFormantDetector(msg.method);
        }
    }
}

registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
