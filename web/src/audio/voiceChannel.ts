// `?worker&url` triggers Vite to bundle the worklet's transitive imports
// (notably ../pitchDetector) into a single ESM module and returns its URL.
// Plain `?url` would return the raw .ts URL with unresolved imports, which
// AudioWorkletGlobalScope cannot follow. We only want the URL form, not the
// worker constructor form, so addModule() loads it like any ESM module.
import workletUrl from './worklets/pitchWorklet.ts?worker&url';
import {PITCH_PROCESSOR_NAME, type ChannelMessage} from './worklets/channelMessage';
import type {AnalysisFrame} from '../wire/frames';

export interface VoiceChannelOptions {
    channelId: string;
    // voiceLabel is consumed by slice 1's SignalrClient.registerChannel()
    // call (hub-side identity of a capturer). Unused in slice 0.
    voiceLabel: string;
    audioContext: AudioContext;
    onFrame(frame: AnalysisFrame): void;
}

export class VoiceChannel {
    private readonly opts: VoiceChannelOptions;
    private node: AudioWorkletNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stream: MediaStream | null = null;
    // muted gates outbound frames client-side, wired by the per-singer mute
    // UI that lands in slice 4 (SingerClient view). Unused in slice 0.
    private muted = false;

    constructor(opts: VoiceChannelOptions) {
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

        this.source = this.opts.audioContext.createMediaStreamSource(stream);
        this.node = new AudioWorkletNode(this.opts.audioContext, PITCH_PROCESSOR_NAME);
        this.node.port.onmessage = (event) => this.handleMessage(event.data);

        this.source.connect(this.node);
        // Worklet has no audible output; do not connect to destination.
    }

    public setMuted(muted: boolean): void {
        this.muted = muted;
    }

    public stop(): void {
        this.source?.disconnect();
        this.node?.disconnect();
        this.stream?.getTracks().forEach((t) => t.stop());
        this.source = null;
        this.node = null;
        this.stream = null;
    }

    private handleMessage(message: ChannelMessage): void {
        if (this.muted) {
            return;
        }
        if (message.type !== 'pitch') {
            return;
        }
        if (!Number.isFinite(message.fundamentalHz)) {
            // Defensive: the worklet's pitchDetector is built to only emit
            // finite Hz values (including 0 for "no pitch"), so NaN/Infinity
            // would indicate a bug upstream. Silent drop keeps the UI from
            // threading NaN through PitchPlot's log-Hz math.
            return;
        }

        const frame: AnalysisFrame = {
            channelId: this.opts.channelId,
            clientTsMs: Math.round(performance.timeOrigin + performance.now()),
            fundamentalHz: message.fundamentalHz,
            confidence: message.confidence,
            rmsDb: message.rmsDb,
        };
        this.opts.onFrame(frame);
    }
}
