import defaultWorkerUrl from './plotWorker.ts?worker&url';
import type {FrameSource} from '../audio/frameRing';
import {PlotMessageType, type PlotMessage, type VoiceEntry} from './plotMessages';

export interface PlotControllerOptions {
    voices: ReadonlyArray<VoiceEntry>;
    backing: {cssWidth: number; cssHeight: number; dpr: number};
    windowMs: number;
    minHz: number;
    maxHz: number;
}

// Main-thread side of the plot worker. Owns the canvas-transfer
// lifecycle and forwards per-channel lifecycle events to the
// worker. Does NOT create SABs itself - the caller provides them,
// because SAB ownership lives with the frame producer
// (VoiceChannel in slice 0, the SignalR DisplayClient in slice 1+).
//
// The worker URL is parameterised so a caller (App.tsx) can opt
// into the WebGPU prototype worker via a URL flag without forking
// the controller's lifecycle logic. Default keeps backwards
// compatibility: callers that do not pass workerUrl get the 2D
// canvas worker exactly as before.
export class PlotController {
    private worker: Worker | null = null;
    private attached = false;
    private readonly workerUrl: string | URL;

    public constructor(workerUrl: string | URL = defaultWorkerUrl) {
        this.workerUrl = workerUrl;
    }

    public attach(canvas: HTMLCanvasElement, opts: PlotControllerOptions): void {
        if (this.attached) {
            throw new Error('PlotController: already attached');
        }
        this.attached = true;
        const offscreen = canvas.transferControlToOffscreen();
        this.worker = new Worker(this.workerUrl, {type: 'module'});
        const init: PlotMessage = {
            type: PlotMessageType.Init,
            canvas: offscreen,
            voices: opts.voices,
            backing: opts.backing,
            windowMs: opts.windowMs,
            minHz: opts.minHz,
            maxHz: opts.maxHz,
            mainNowAtInitMs: performance.now(),
        };
        this.worker.postMessage(init, [offscreen]);
    }

    public setRoster(voices: ReadonlyArray<VoiceEntry>): void {
        this.post({type: PlotMessageType.SetRoster, voices});
    }

    public setBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        this.post({type: PlotMessageType.SetBacking, cssWidth, cssHeight, dpr});
    }

    /**
     * Tell the worker to start reading the given channel's frame ring.
     * The SAB inside `source` is passed by reference (SharedArrayBuffer
     * is shared, not transferred); do NOT include it in the transfer
     * list - doing so throws DataCloneError.
     */
    public attachChannel(channelId: string, source: FrameSource): void {
        this.post({type: PlotMessageType.AttachChannel, channelId, source});
    }

    public detachChannel(channelId: string): void {
        this.post({type: PlotMessageType.DetachChannel, channelId});
    }

    public rebaseChannel(channelId: string, epochOffsetMs: number): void {
        this.post({type: PlotMessageType.RebaseChannel, channelId, epochOffsetMs});
    }

    public dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.attached = false;
    }

    private post(msg: PlotMessage): void {
        this.worker?.postMessage(msg);
    }
}
