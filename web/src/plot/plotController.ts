import workerUrl from './plotWorker.ts?worker&url';
import type {AnalysisFrame} from '../wire/frames';
import type {PlotMessage, VoiceEntry} from './plotMessages';

export interface PlotControllerOptions {
    voices: ReadonlyArray<VoiceEntry>;
    backing: {cssWidth: number; cssHeight: number; dpr: number};
    windowMs: number;
    minHz: number;
    maxHz: number;
    traceCapacity: number;
}

// Main-thread side of the plot worker. One controller per mounted
// canvas; attach() transfers the OffscreenCanvas and spins the worker
// up, dispose() terminates it. publishFrame is the per-frame hot path
// and stays non-allocating beyond the single postMessage wrapper.
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
            traceCapacity: opts.traceCapacity,
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

    public publishFrame(frame: AnalysisFrame): void {
        if (!this.worker) {
            return;
        }
        const msg: PlotMessage = {type: 'frame', frame, clientNowMs: performance.now()};
        this.worker.postMessage(msg);
    }

    public dispose(): void {
        this.worker?.terminate();
        this.worker = null;
        this.attached = false;
    }
}
