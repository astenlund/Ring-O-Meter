// AudioWorklet shell. The DSP itself lives in the testable pitchDetector
// and rmsDb modules; this file just wires the buffer plumbing and posts
// PitchResult-augmented messages back to the main thread.

import {detectPitch} from '../pitchDetector';
import {computeRmsDb} from '../rmsDb';
import {PITCH_PROCESSOR_NAME, type ChannelMessage} from './channelMessage';

const FRAME_SIZE = 1024;
const PUBLISH_INTERVAL_FRAMES = 1; // every ~21 ms at 48 kHz -> ~47 Hz publish (matches spec)

class PitchProcessor extends AudioWorkletProcessor {
    private readonly buffer = new Float32Array(FRAME_SIZE);
    private bufferIndex = 0;
    private framesSinceLastPublish = 0;

    public process(
        inputs: Float32Array[][],
        _outputs: Float32Array[][],
    ): boolean {
        const channel = inputs[0]?.[0];
        if (!channel) {
            return true;
        }

        // Batch-copy the render quantum (typically 128 samples) into the ring
        // buffer with TypedArray.set, which compiles to a memcpy-class path.
        // The former per-sample loop ran ~128 branches per quantum on the
        // audio thread; this keeps the same logical behaviour (publish when
        // the buffer is full) at a fraction of the per-sample overhead.
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
        const rmsDb = computeRmsDb(this.buffer);
        const message: ChannelMessage = {
            type: 'pitch',
            fundamentalHz: result.fundamentalHz,
            confidence: result.confidence,
            rmsDb,
            // currentTime is the AudioContext time the audio thread is
            // servicing right now. Capturing it here (audio thread)
            // preserves the real capture instant across any main-thread
            // GC-induced port-dispatch delay.
            captureContextTime: currentTime,
        };
        this.port.postMessage(message);
    }
}

registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
