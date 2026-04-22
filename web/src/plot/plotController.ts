import workerUrl from './plotWorker.ts?worker&url';
import type {PlotMessage, VoiceEntry} from './plotMessages';

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
export class PlotController {
    private worker: Worker | null = null;
    private attached = false;

    public attach(canvas: HTMLCanvasElement, opts: PlotControllerOptions): void {
        if (this.attached) {
            throw new Error('PlotController: already attached');
        }
        this.attached = true;
        const offscreen = canvas.transferControlToOffscreen();
        this.worker = new Worker(workerUrl, {type: 'module'});
        const init: PlotMessage = {
            type: 'init',
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
        if (!this.worker) {
            return;
        }
        const msg: PlotMessage = {type: 'setRoster', voices};
        this.worker.postMessage(msg);
    }

    public setBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        if (!this.worker) {
            return;
        }
        const msg: PlotMessage = {type: 'setBacking', cssWidth, cssHeight, dpr};
        this.worker.postMessage(msg);
    }

    /**
     * Tell the worker to start reading from this SAB for the given
     * channel. SAB is passed by reference (SharedArrayBuffer is
     * shared, not transferred); do NOT include it in the transfer
     * list - doing so throws DataCloneError.
     */
    public attachChannel(channelId: string, sab: SharedArrayBuffer, perfNowAtContextTimeZero: number): void {
        if (!this.worker) {
            return;
        }
        const msg: PlotMessage = {
            type: 'attachChannel',
            channelId,
            sab,
            perfNowAtContextTimeZero,
        };
        this.worker.postMessage(msg);
    }

    public detachChannel(channelId: string): void {
        if (!this.worker) {
            return;
        }
        const msg: PlotMessage = {type: 'detachChannel', channelId};
        this.worker.postMessage(msg);
    }

    public rebaseChannel(channelId: string, perfNowAtContextTimeZero: number): void {
        if (!this.worker) {
            return;
        }
        const msg: PlotMessage = {
            type: 'rebaseChannel',
            channelId,
            perfNowAtContextTimeZero,
        };
        this.worker.postMessage(msg);
    }

    public dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.attached = false;
    }
}
