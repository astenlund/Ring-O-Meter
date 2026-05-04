// Test-only fanout VoiceChannel: one mic + one worklet, but emits N
// frame rings (with per-ring pitch offsets) instead of one. Mirrors the
// public shape of VoiceChannel (channelId, voiceLabel, rebaseCount,
// start, stop) so useVoiceChannels can construct either via a ternary
// branch.
//
// See voiceChannel.ts for the production single-ring counterpart and
// the start()/stop() ordering invariants this file extends to N rings.
//
// Cleanup: rm this file along with fanoutConstants.ts and
// fanoutWorklet.ts when the fanout test mode is retired.

// `?worker&url` suffix is mandatory: plain `?url` returns the raw .ts
// path which AudioWorkletGlobalScope cannot resolve. Same contract as
// voiceChannel.ts:1-6.
import fanoutWorkletUrl from './fanoutWorklet.ts?worker&url';
import {AudioContextEpoch} from '../audio/audioContextEpoch';
import {createFrameRing, FrameRingReader, type FrameSource} from '../audio/frameRing';
import type {VoiceChannelEvents} from '../audio/voiceChannel';
import {publishChannel, revokeChannel} from './channelBridge';
import {PITCH_FANOUT_PROCESSOR_NAME} from './fanoutConstants';

export interface FanoutVoiceChannelOptions extends VoiceChannelEvents {
    channelId: string;
    voiceLabel: string;
    audioContext: AudioContext;
    // length === pitchOffsetsCents.length === fanout count. Each entry
    // is the channelId emitted via onFrameSourceReady/Gone/Rebased for
    // the i-th ring; matches the channelId of the corresponding render
    // slot in App.tsx.
    derivedChannelIds: readonly string[];
    pitchOffsetsCents: readonly number[];
}

export class FanoutVoiceChannel {
    private readonly opts: FanoutVoiceChannelOptions;
    private readonly epoch: AudioContextEpoch;
    private node: AudioWorkletNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stream: MediaStream | null = null;
    private readers: FrameRingReader[] = [];

    public constructor(opts: FanoutVoiceChannelOptions) {
        if (opts.derivedChannelIds.length !== opts.pitchOffsetsCents.length) {
            throw new Error(
                'FanoutVoiceChannel: derivedChannelIds and pitchOffsetsCents must have equal length',
            );
        }
        if (opts.derivedChannelIds.length === 0) {
            throw new Error('FanoutVoiceChannel: at least one derived channel is required');
        }
        this.opts = opts;
        this.epoch = new AudioContextEpoch({
            audioContext: opts.audioContext,
            onRebase: (offsetMs) => this.handleRebase(offsetMs),
        });
    }

    public get channelId(): string {
        return this.opts.channelId;
    }

    public get voiceLabel(): string {
        return this.opts.voiceLabel;
    }

    public get rebaseCount(): number {
        return this.epoch.rebaseCount;
    }

    public async start(stream: MediaStream): Promise<void> {
        this.stream = stream;
        await this.opts.audioContext.audioWorklet.addModule(fanoutWorkletUrl);

        const count = this.opts.derivedChannelIds.length;
        // captureInitialOffset() is called ONCE; the same initialOffset
        // seeds every reader. All N rings share the same AudioContext
        // clock, so a single offset is correct. Calling it per-ring
        // would drift epoch.lastPropagatedOffset and corrupt the first
        // rebase comparison.
        const initialOffset = this.epoch.captureInitialOffset();
        const sabs: SharedArrayBuffer[] = [];
        const sources: FrameSource[] = [];
        const readers: FrameRingReader[] = [];
        for (let i = 0; i < count; i++) {
            const sab = createFrameRing();
            sabs.push(sab);
            readers.push(new FrameRingReader(sab, initialOffset));
            sources.push({sab, epochOffsetMs: initialOffset});
        }
        this.readers = readers;

        const pitchMultipliers = this.opts.pitchOffsetsCents.map(
            (cents) => Math.pow(2, cents / 1200),
        );

        this.source = this.opts.audioContext.createMediaStreamSource(stream);
        this.node = new AudioWorkletNode(this.opts.audioContext, PITCH_FANOUT_PROCESSOR_NAME, {
            processorOptions: {frameRingSabs: sabs, pitchMultipliers},
        });
        this.source.connect(this.node);

        // Ordering invariant from voiceChannel.ts:100-121 generalised to
        // N rings: ready×N -> publishChannel×N -> arm×1. arm() must be
        // last so all consumers (useFrameState, plot worker) and the
        // test bridge entries exist before any rebase callback can fire.
        for (let i = 0; i < count; i++) {
            const id = this.opts.derivedChannelIds[i];
            this.opts.onFrameSourceReady(id, sources[i], readers[i]);
            publishChannel(
                id,
                this.opts.audioContext,
                readers[i],
                () => this.epoch.rebaseCount,
            );
        }

        this.epoch.arm();
    }

    public stop(): void {
        this.epoch.stop();
        this.source?.disconnect();
        this.node?.disconnect();
        this.stream?.getTracks().forEach((t) => t.stop());
        this.source = null;
        this.node = null;
        this.stream = null;
        const wasReady = this.readers.length > 0;
        this.readers = [];
        if (wasReady) {
            for (const id of this.opts.derivedChannelIds) {
                revokeChannel(id);
                this.opts.onFrameSourceGone(id);
            }
        }
    }

    private handleRebase(offsetMs: number): void {
        // Guard matches the spirit of voiceChannel.ts's `this.reader?.setOffset`
        // pattern: a statechange event queued before stop() cleared readers must
        // not try to index into the now-empty array.
        if (this.readers.length === 0) {
            return;
        }
        // Mirrors voiceChannel.ts:140-143 across N readers: setOffset
        // on each reader BEFORE firing onFrameSourceRebased, so any
        // consumer holding the same reader instance (e.g., useFrameState)
        // sees the corrected offset before the rebase event lands. The
        // contract documented at voiceChannel.ts:26-33 applies per ring.
        for (let i = 0; i < this.readers.length; i++) {
            this.readers[i].setOffset(offsetMs);
            this.opts.onFrameSourceRebased(this.opts.derivedChannelIds[i], offsetMs);
        }
    }
}
