// AudioWorklet shell. The DSP lives in the testable pitchDetector and
// rmsDb modules; OctaveStabilizer and the SAB writer live alongside
// because per-frame data leaves the audio thread via the ring rather
// than via port.postMessage. The stabilized value is what reaches the
// ring, which is what every consumer (NoteReadout, plot worker) reads.

import {detectPitch} from '../pitchDetector';
import {computeRmsDb} from '../rmsDb';
import {OctaveStabilizer} from '../octaveStabilizer';
import {PITCH_PROCESSOR_NAME} from './channelMessage';
import {FrameRingWriter} from '../frameRing';

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

    public constructor(options?: AudioWorkletNodeOptions) {
        super();
        const opts = (options?.processorOptions ?? {}) as PitchProcessorOptions;
        if (!opts.frameRingSab) {
            throw new Error('PitchProcessor: processorOptions.frameRingSab is required');
        }
        this.writer = new FrameRingWriter(opts.frameRingSab);
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
        // rmsDb is not yet surfaced in the ring; when a consumer
        // materialises (vowel-matching, chop-cop), add a Float32
        // column to frameRing.ts at the next byte offset and write it
        // alongside the existing fields. Compute it here to keep the
        // shape consistent across future column additions.
        computeRmsDb(this.buffer);
        const {hz: stabilizedHz} = this.stabilizer.apply(result.fundamentalHz);
        // currentTime is AudioContext seconds; multiply by 1000 for
        // ms matching the ring's contextMs field semantics. Readers
        // (main + worker) convert to paint epoch via their offset.
        this.writer.publish(currentTime * 1000, stabilizedHz, result.confidence);
    }
}

registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
