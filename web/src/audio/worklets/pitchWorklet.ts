// AudioWorklet shell. The DSP itself lives in the testable
// pitchDetector module; this file just wires the buffer plumbing and posts
// PitchResult-augmented messages back to the main thread.

import {detectPitch} from '../pitchDetector';
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

        for (let i = 0; i < channel.length; i++) {
            this.buffer[this.bufferIndex++] = channel[i];
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
        };
        this.port.postMessage(message);
    }
}

function computeRmsDb(buffer: Float32Array): number {
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
        sumSquares += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sumSquares / buffer.length);
    if (rms <= 1e-9) {
        return -120;
    }

    return 20 * Math.log10(rms);
}

registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
