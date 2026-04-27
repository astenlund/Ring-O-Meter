// `?worker&url` triggers Vite to bundle the worklet's transitive imports
// (notably ../pitchDetector) into a single ESM module and returns its URL.
// Plain `?url` would return the raw .ts URL with unresolved imports, which
// AudioWorkletGlobalScope cannot follow. We only want the URL form, not the
// worker constructor form, so addModule() loads it like any ESM module.
import workletUrl from './worklets/pitchWorklet.ts?worker&url';
import {PITCH_PROCESSOR_NAME} from './constants';
import {FrameRingReader, createFrameRing} from './frameRing';
import {AudioContextEpoch} from './audioContextEpoch';
import {publishChannel, revokeChannel} from '../__testing/channelBridge';

export interface VoiceChannelEvents {
    // A fresh ring is available. The reader is bound to the channel's
    // SAB and already configured with the initial perf-to-context
    // offset; consumers (useFrameState, PitchPlot via App) should
    // register it straight through.
    onFrameSourceReady(channelId: string, reader: FrameRingReader, perfNowAtContextTimeZero: number): void;
    // Channel was torn down (slot change, unmount, stop()). Consumers
    // should unregister any cached reader references.
    onFrameSourceGone(channelId: string): void;
    // AudioContext reached 'running' after a suspend, or for the first
    // time. The offset is the new perf-now-at-context-time-zero value.
    // The reader passed through onFrameSourceReady has ALREADY had its
    // offset updated by VoiceChannel before this fires, so consumers
    // holding that same instance (e.g., useFrameState) must not call
    // setOffset on it a second time. Consumers holding a DIFFERENT
    // reader over the same SAB (e.g., the plot worker, which owns its
    // own FrameRingReader across the thread boundary) must update
    // their own reader's offset from this callback.
    onFrameSourceRebased(channelId: string, perfNowAtContextTimeZero: number): void;
}

export interface VoiceChannelOptions extends VoiceChannelEvents {
    channelId: string;
    // voiceLabel is consumed by slice 1's SignalrClient.registerChannel()
    // call (hub-side identity of a capturer). Unused in slice 0.
    voiceLabel: string;
    audioContext: AudioContext;
}

export class VoiceChannel {
    private readonly opts: VoiceChannelOptions;
    private readonly epoch: AudioContextEpoch;
    private node: AudioWorkletNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stream: MediaStream | null = null;
    private reader: FrameRingReader | null = null;

    public constructor(opts: VoiceChannelOptions) {
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

    // Lifecycle introspection: how many times this channel's
    // AudioContext entered 'running' with enough offset drift (or for
    // the first time) to propagate a rebase. Read-only handle for
    // tests + the channel test bridge; gating policy lives in
    // AudioContextEpoch.
    public get rebaseCount(): number {
        return this.epoch.rebaseCount;
    }

    public async start(stream: MediaStream): Promise<void> {
        this.stream = stream;
        await this.opts.audioContext.audioWorklet.addModule(workletUrl);

        const sab = createFrameRing();
        const initialOffset = this.epoch.captureInitialOffset();
        this.reader = new FrameRingReader(sab, initialOffset);

        this.source = this.opts.audioContext.createMediaStreamSource(stream);
        this.node = new AudioWorkletNode(this.opts.audioContext, PITCH_PROCESSOR_NAME, {
            processorOptions: {frameRingSab: sab},
        });
        // slice N (slice number TBD): worklet -> main port message
        // variants will be wired here (errors, diagnostics, parameter
        // updates). Per-frame data flows via SAB; the port is currently
        // unused at steady state. The literal `N` is the documented
        // marker for indeterminate future slices (see CLAUDE.md's
        // Future-slice plumbing section); substitute the real number
        // once a concrete slice claims this seam.
        this.source.connect(this.node);
        // No audible output; don't connect to destination.

        // Notify consumers + publish the test bridge entry BEFORE
        // arming the statechange listener. arm() is the only call
        // here that can produce future onFrameSourceRebased
        // callbacks, so doing it last guarantees every consumer
        // (useFrameState, PlotController) and the bridge entry exist
        // by the time any rebase can fire for this channelId.
        // Without this ordering a statechange queued between arm()
        // and onFrameSourceReady would dispatch a rebase for a
        // channelId consumers don't yet know about; today the two
        // calls are on the same JS turn so no DOM event can
        // interleave, but the type system cannot enforce that, so
        // we encode the contract through the ordering itself.
        this.opts.onFrameSourceReady(this.opts.channelId, this.reader, initialOffset);

        publishChannel(
            this.opts.channelId,
            this.opts.audioContext,
            this.reader,
            () => this.epoch.rebaseCount,
        );

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
        const wasReady = this.reader !== null;
        this.reader = null;
        if (wasReady) {
            revokeChannel(this.opts.channelId);
            this.opts.onFrameSourceGone(this.opts.channelId);
        }
    }

    private handleRebase(offsetMs: number): void {
        this.reader?.setOffset(offsetMs);
        this.opts.onFrameSourceRebased(this.opts.channelId, offsetMs);
    }
}
