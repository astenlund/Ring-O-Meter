import defaultWorkerUrl from './plotWorker.ts?worker&url';
import type {FrameSource} from '../audio/frameRing';
import {
    applyCanvasBacking,
    drawBackground,
    drawGrid,
    drawLegend,
    makeHzToY,
    type CanvasBacking,
    type CanvasSize,
    type HzRange,
    type PaintFrame,
} from './paint';
import {PlotMessageType, type PlotMessage, type VoiceEntry} from './plotMessages';

export interface PlotControllerOptions {
    voices: ReadonlyArray<VoiceEntry>;
    backing: {cssWidth: number; cssHeight: number; dpr: number};
    windowMs: number;
    minHz: number;
    maxHz: number;
}

export interface PlotUnderlayOptions {
    voices: ReadonlyArray<VoiceEntry>;
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

    private underlayCtx: CanvasRenderingContext2D | null = null;
    private underlayOpts: PlotUnderlayOptions | null = null;
    private underlayBacking: CanvasBacking = {cssWidth: 0, cssHeight: 0, dpr: 1};
    private underlaySize: CanvasSize = {width: 0, height: 0};

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
        if (this.underlayOpts) {
            this.underlayOpts = {...this.underlayOpts, voices};
            this.repaintUnderlay();
        }
    }

    public setBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        this.post({type: PlotMessageType.SetBacking, cssWidth, cssHeight, dpr});
    }

    /**
     * Paint static elements (background, grid, legend) onto a
     * caller-supplied 2D context. Used by the WebGPU prototype, where
     * the WebGPU canvas only renders dynamic traces; the underlay
     * canvas behind it carries the static chrome. Called only from
     * PitchPlot's WebGPU arm (the 2D arm's underlay effect early-exits
     * on `!useUnderlay` and never registers a context here, so this
     * method is a no-op in the production code path until the
     * renderer flag opts a session into WebGPU).
     */
    public setUnderlay(ctx: CanvasRenderingContext2D, opts: PlotUnderlayOptions): void {
        this.underlayCtx = ctx;
        this.underlayOpts = opts;
        this.repaintUnderlay();
    }

    public setUnderlayBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        this.underlayBacking.cssWidth = cssWidth;
        this.underlayBacking.cssHeight = cssHeight;
        this.underlayBacking.dpr = dpr;
        this.repaintUnderlay();
    }

    private repaintUnderlay(): void {
        const ctx = this.underlayCtx;
        const opts = this.underlayOpts;
        if (!ctx || !opts || this.underlayBacking.cssHeight === 0) {
            return;
        }
        const canvas = ctx.canvas;
        applyCanvasBacking(canvas, ctx, this.underlayBacking, this.underlaySize);
        const range: HzRange = {minHz: opts.minHz, maxHz: opts.maxHz};
        const hzToY = makeHzToY(range, this.underlaySize.height);
        const frame: PaintFrame = {
            ctx,
            size: this.underlaySize,
            hzToY,
            nowMs: 0,
            windowMs: 0,
        };
        drawBackground(frame);
        drawGrid(frame, range);
        drawLegend(frame, opts.voices);
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
        this.underlayCtx = null;
        this.underlayOpts = null;
    }

    private post(msg: PlotMessage): void {
        this.worker?.postMessage(msg);
    }
}
