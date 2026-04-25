// `?worker&url` triggers Vite to bundle the worklet's transitive imports
// (notably ../pitchDetector) into a single ESM module and returns its URL.
// Plain `?url` would return the raw .ts URL with unresolved imports, which
// AudioWorkletGlobalScope cannot follow. We only want the URL form, not the
// worker constructor form, so addModule() loads it like any ESM module.
import workletUrl from './worklets/pitchWorklet.ts?worker&url';
import {PITCH_PROCESSOR_NAME} from './constants';
import {FrameRingReader, createFrameRing} from './frameRing';

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

// Test-only bridge. Populated only when a harness has armed
// globalThis.__ringOMeterChannels before navigation (see
// web/e2e/smoothness.spec.ts). Production never creates the map, so the
// guard in start() is always false and nothing is exposed. rebaseCount
// increments inside handleStateChange AFTER setOffset runs, letting a
// test wait for the rebase to have observably taken effect rather than
// racing statechange listener order against audioContext.resume().
interface ChannelTestBridge {
    audioContext: AudioContext;
    reader: FrameRingReader;
    rebaseCount: number;
}

type TestBridgeGlobal = {__ringOMeterChannels?: Map<string, ChannelTestBridge>};

export class VoiceChannel {
    private readonly opts: VoiceChannelOptions;
    private node: AudioWorkletNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stream: MediaStream | null = null;
    private reader: FrameRingReader | null = null;
    // hasFiredRunningRebase tracks whether we've seen the first
    // 'running' state transition. The first one always fires a rebase
    // so the perfNow->contextTimeZero offset reflects the real anchor
    // (start() may return before the context actually resumes on
    // user-gesture-gated platforms). Subsequent 'running' events only
    // fire if the offset drifted (fold-in after suspend/resume).
    private hasFiredRunningRebase = false;
    private lastPropagatedOffset = 0;
    private stateChangeHandler: (() => void) | null = null;
    private testBridge: ChannelTestBridge | null = null;

    public constructor(opts: VoiceChannelOptions) {
        this.opts = opts;
    }

    public get channelId(): string {
        return this.opts.channelId;
    }

    public get voiceLabel(): string {
        return this.opts.voiceLabel;
    }

    public async start(stream: MediaStream): Promise<void> {
        this.stream = stream;
        await this.opts.audioContext.audioWorklet.addModule(workletUrl);

        const sab = createFrameRing();

        const initialOffset = this.computeOffset();
        this.lastPropagatedOffset = initialOffset;
        this.reader = new FrameRingReader(sab, initialOffset);

        this.source = this.opts.audioContext.createMediaStreamSource(stream);
        this.node = new AudioWorkletNode(this.opts.audioContext, PITCH_PROCESSOR_NAME, {
            processorOptions: {frameRingSab: sab},
        });
        // slice N: worklet -> main port message variants will be wired
        // here (errors, diagnostics, parameter updates). Per-frame data
        // flows via SAB; the port is currently unused at steady state.
        this.source.connect(this.node);
        // No audible output; don't connect to destination.

        this.stateChangeHandler = () => this.handleStateChange();
        this.opts.audioContext.addEventListener('statechange', this.stateChangeHandler);

        // Emit the ready event after the worklet is wired so consumers
        // can register the reader + attach the plot worker as soon as
        // frames may start flowing.
        this.opts.onFrameSourceReady(this.opts.channelId, this.reader, initialOffset);

        const bridgeMap = (globalThis as TestBridgeGlobal).__ringOMeterChannels;
        if (bridgeMap) {
            this.testBridge = {
                audioContext: this.opts.audioContext,
                reader: this.reader,
                rebaseCount: 0,
            };
            bridgeMap.set(this.opts.channelId, this.testBridge);
        }
    }

    public stop(): void {
        if (this.stateChangeHandler) {
            this.opts.audioContext.removeEventListener('statechange', this.stateChangeHandler);
            this.stateChangeHandler = null;
        }
        this.source?.disconnect();
        this.node?.disconnect();
        this.stream?.getTracks().forEach((t) => t.stop());
        this.source = null;
        this.node = null;
        this.stream = null;
        const wasReady = this.reader !== null;
        this.reader = null;
        if (this.testBridge !== null) {
            (globalThis as TestBridgeGlobal).__ringOMeterChannels?.delete(this.opts.channelId);
            this.testBridge = null;
        }
        if (wasReady) {
            this.opts.onFrameSourceGone(this.opts.channelId);
        }
    }

    private computeOffset(): number {
        // While the AudioContext is suspended (pre-user-gesture),
        // currentTime = 0 and the offset = performance.now() at eval
        // time; the first entry to 'running' triggers a rebase that
        // corrects this placeholder.
        return performance.now() - this.opts.audioContext.currentTime * 1000;
    }

    private handleStateChange(): void {
        const state = this.opts.audioContext.state;
        if (state !== 'running') {
            return;
        }
        const offset = this.computeOffset();
        const shouldFire = !this.hasFiredRunningRebase
            || Math.abs(offset - this.lastPropagatedOffset) > 1;
        if (!shouldFire) {
            return;
        }
        this.hasFiredRunningRebase = true;
        this.lastPropagatedOffset = offset;
        this.reader?.setOffset(offset);
        if (this.testBridge !== null) {
            this.testBridge.rebaseCount += 1;
        }
        this.opts.onFrameSourceRebased(this.opts.channelId, offset);
    }
}
