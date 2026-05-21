import defaultWorkerUrl from './plotWorker2dCanvas.ts?worker&url';
import type {FrameSource} from '../audio/frameRing';
import {
    applyCanvasBacking,
    drawBackground,
    drawGrid,
    drawLegend,
    drawVowelChrome,
    makeHzToY,
    type CanvasBacking,
    type CanvasSize,
    type HzRange,
    type PaintFrame,
} from './paint';
import {
    PlotMessageType,
    type PlotMessage,
    type SetChordClassificationMessage,
    type VoiceEntry,
} from './plotMessages';
import {F1_MAX, F1_MIN, F2_MAX, F2_MIN} from './vowelModule';

// heuristic: max-voices-chord-classification
const MAX_VOICES = 8;

export interface PlotControllerOptions {
    voices: ReadonlyArray<VoiceEntry>;
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
    // When true, forwarded in the Init message so the worker suppresses
    // vowel and chord-bars rendering. The trace-only arm's controller
    // must not call attachVowelCanvas or attachChordBarsCanvas; those
    // canvases are never allocated in that path.
    private readonly traceOnly: boolean;

    private underlayCtx: CanvasRenderingContext2D | null = null;
    private underlayOpts: PlotUnderlayOptions | null = null;
    private underlayBacking: CanvasBacking = {cssWidth: 0, cssHeight: 0, dpr: 1};
    private underlaySize: CanvasSize = {width: 0, height: 0};

    private vowelUnderlayCtx: CanvasRenderingContext2D | null = null;
    private vowelUnderlayBacking: CanvasBacking = {cssWidth: 0, cssHeight: 0, dpr: 1};
    private vowelUnderlaySize: CanvasSize = {width: 0, height: 0};

    // Reused message object for setChordClassification. Both the object
    // and the residualsBySlot buffer survive across calls to keep
    // hot-path allocations at zero.
    private readonly _chordClassificationMsg: SetChordClassificationMessage = {
        type: PlotMessageType.SetChordClassification,
        lockedChordType: null,
        rootChannelId: null,
        rootHz: 0,
        residualsBySlot: new Float32Array(MAX_VOICES),
    };

    public constructor(workerUrl: string | URL = defaultWorkerUrl, traceOnly = false) {
        this.workerUrl = workerUrl;
        this.traceOnly = traceOnly;
    }

    private ensureWorker(): Worker {
        if (!this.worker) {
            this.worker = new Worker(this.workerUrl, {type: 'module'});
        }

        return this.worker;
    }

    public get isAttached(): boolean {
        return this.attached;
    }

    public attach(canvas: HTMLCanvasElement, opts: PlotControllerOptions): void {
        if (this.attached) {
            // PlotController is one-shot per lifetime: the worker's Init
            // handler ignores subsequent Init messages, and the canvas
            // passed via transferControlToOffscreen is irrevocably
            // transferred. Re-attach after detach is unsupported -
            // construct a fresh PlotController via dispose() + new
            // PlotController() (or use a fresh App-level useState slot).
            // The non-owning unmount path in PitchPlot deliberately
            // does NOT reset this flag, because doing so would mask
            // this fundamental constraint with what looks like
            // working code that paints onto a stale canvas.
            throw new Error(
                'PlotController.attach: already attached. PlotController is one-shot per lifetime; '
                + 'dispose() and construct a fresh instance to re-attach.',
            );
        }
        this.attached = true;
        const worker = this.ensureWorker();
        const offscreen = canvas.transferControlToOffscreen();
        const init: PlotMessage = {
            type: PlotMessageType.Init,
            canvas: offscreen,
            voices: opts.voices,
            windowMs: opts.windowMs,
            minHz: opts.minHz,
            maxHz: opts.maxHz,
            mainNowAtInitMs: performance.now(),
            ...(this.traceOnly ? {traceOnly: true} : {}),
        };
        worker.postMessage(init, [offscreen]);
    }

    public attachVowelCanvas(canvas: HTMLCanvasElement): void {
        // No-op in trace-only mode: the worker suppresses InitVowelCanvas
        // when traceOnly is set, and App.tsx does not mount VowelPlot in
        // that path, so this guard is a safety net against accidental calls.
        if (this.traceOnly) {
            return;
        }
        const worker = this.ensureWorker();
        const offscreen = canvas.transferControlToOffscreen();
        const msg: PlotMessage = {
            type: PlotMessageType.InitVowelCanvas,
            canvas: offscreen,
        };
        worker.postMessage(msg, [offscreen]);
    }

    public attachVowelChannel(channelId: string, color: string, source: FrameSource): void {
        this.post({type: PlotMessageType.AttachVowelChannel, channelId, color, source});
    }

    public detachVowelChannel(channelId: string): void {
        this.post({type: PlotMessageType.DetachVowelChannel, channelId});
    }

    public rebaseVowelChannel(channelId: string, epochOffsetMs: number): void {
        this.post({type: PlotMessageType.RebaseVowelChannel, channelId, epochOffsetMs});
    }

    public setVowelBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        this.post({type: PlotMessageType.SetVowelBacking, cssWidth, cssHeight, dpr});
    }

    /**
     * Register the vowel underlay 2D context. Used only on the WebGPU
     * arm; the 2D arm paints vowel chrome inline in the worker each
     * frame via drawVowelChrome. Repaints the chrome immediately if
     * backing dims are known.
     */
    public setVowelUnderlay(ctx: CanvasRenderingContext2D): void {
        this.vowelUnderlayCtx = ctx;
        this.repaintVowelUnderlay();
    }

    public setVowelUnderlayBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        this.vowelUnderlayBacking.cssWidth = cssWidth;
        this.vowelUnderlayBacking.cssHeight = cssHeight;
        this.vowelUnderlayBacking.dpr = dpr;
        this.repaintVowelUnderlay();
    }

    private repaintVowelUnderlay(): void {
        const ctx = this.vowelUnderlayCtx;
        if (!ctx || this.vowelUnderlayBacking.cssHeight === 0) {
            return;
        }
        const canvas = ctx.canvas;
        applyCanvasBacking(canvas, ctx, this.vowelUnderlayBacking, this.vowelUnderlaySize);
        drawVowelChrome(
            ctx,
            this.vowelUnderlaySize,
            {min: F1_MIN, max: F1_MAX},
            {min: F2_MIN, max: F2_MAX},
        );
    }

    public setRoster(voices: ReadonlyArray<VoiceEntry>): void {
        this.post({type: PlotMessageType.SetRoster, voices});
        if (this.underlayOpts) {
            this.underlayOpts = {...this.underlayOpts, voices};
            this.repaintUnderlay();
        }
        // Note: vowel underlay does NOT repaint on roster changes for this
        // slice. drawVowelChrome takes axis ranges only (no per-voice
        // content), so a roster change has no visible effect on the chrome.
        // If a future slice introduces a per-voice vowel legend, fan out
        // here and add a corresponding test for the WebGPU arm's repaint
        // cadence.
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

    public attachChordBarsCanvas(canvas: OffscreenCanvas): void {
        // No-op in trace-only mode: the worker suppresses InitChordBarsCanvas
        // when traceOnly is set, and App.tsx does not mount ChordAwareDisplay
        // in that path.
        if (this.traceOnly) {
            return;
        }
        const worker = this.ensureWorker();
        const msg: PlotMessage = {
            type: PlotMessageType.InitChordBarsCanvas,
            canvas,
        };
        worker.postMessage(msg, [canvas]);
    }

    public setChordBarsBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        this.post({type: PlotMessageType.SetChordBarsBacking, cssWidth, cssHeight, dpr});
    }

    public setChordClassification(
        lockedChordType: number | null,
        rootChannelId: string | null,
        rootHz: number,
        residualsBySlot: Float32Array,
    ): void {
        this._chordClassificationMsg.lockedChordType = lockedChordType;
        this._chordClassificationMsg.rootChannelId = rootChannelId;
        this._chordClassificationMsg.rootHz = rootHz;
        this._chordClassificationMsg.residualsBySlot.set(residualsBySlot);
        this.post(this._chordClassificationMsg);
    }

    public dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.attached = false;
        this.underlayCtx = null;
        this.underlayOpts = null;
        this.vowelUnderlayCtx = null;
    }

    private post(msg: PlotMessage): void {
        this.worker?.postMessage(msg);
    }
}
