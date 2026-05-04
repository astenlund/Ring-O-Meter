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
// Cleanup: rm this file along with fanoutConstants.ts and
// fanoutVoiceChannel.ts when the fanout test mode is retired.

import {detectPitch} from '../audio/pitchDetector';
import {computeRmsDb} from '../audio/rmsDb';
import {OctaveStabilizer} from '../audio/octaveStabilizer';
import {FrameRingWriter, type PublishFrame} from '../audio/frameRing';
import {PITCH_FANOUT_PROCESSOR_NAME} from './fanoutConstants';
import {FormantDetector} from '../audio/formantDetector';

const FRAME_SIZE = 1024;
const PUBLISH_INTERVAL_FRAMES = 1;

interface FanoutProcessorOptions {
    frameRingSabs?: SharedArrayBuffer[];
    pitchMultipliers?: number[];
}

class FanoutPitchProcessor extends AudioWorkletProcessor {
    private readonly buffer = new Float32Array(FRAME_SIZE);
    private bufferIndex = 0;
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
        this.formantDetector = new FormantDetector({
            inputRate: sampleRate,
            decimatedRate: 12000,
            decimatorCutoffHz: 5500,
            lpcOrder: 14,
            formantCount: 4,
        });
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
            return;
        }
        const rmsDb = computeRmsDb(this.buffer);
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
        this.formantDetector.process(this.buffer);
        const formants = this.formantDetector.result.frequencies;
        this.scratch.f1Hz = Number.isFinite(formants[0]) ? formants[0] : 0;
        this.scratch.f2Hz = Number.isFinite(formants[1]) ? formants[1] : 0;
        this.scratch.f3Hz = Number.isFinite(formants[2]) ? formants[2] : 0;
        this.scratch.f4Hz = Number.isFinite(formants[3]) ? formants[3] : 0;

        for (let i = 0; i < this.writers.length; i++) {
            const m = this.multipliers[i];
            this.scratch.fundamentalHz = stabilized.hz * m;
            this.scratch.fundamentalHzRaw = fundamentalHzRaw * m;
            this.writers[i].publish(this.scratch);
        }
    }
}

registerProcessor(PITCH_FANOUT_PROCESSOR_NAME, FanoutPitchProcessor);
