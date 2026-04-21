/// <reference lib="webworker" />

// PlotController always posts `init` before any other message from the
// same main-thread tick it was constructed in; structured-clone
// ordering guarantees `init` arrives first at the worker. Keep that
// invariant: if a future caller separates construction from first
// attach, the worker must either buffer pre-init `frame` messages or
// the caller must explicitly post `init` before any `frame`.

import {TraceBuffer} from '../session/traceBuffer';
import {
    applyCanvasBacking,
    drawBackground,
    drawGrid,
    drawLegend,
    drawTraces,
    makeHzToY,
    type CanvasBacking,
    type CanvasSize,
    type HzRange,
    type PaintFrame,
} from './paint';
import type {PlotMessage, VoiceEntry} from './plotMessages';

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
const backing: CanvasBacking = {cssWidth: 0, cssHeight: 0, dpr: 1};
let voices: ReadonlyArray<VoiceEntry> = [];
let buffers: Record<string, TraceBuffer> = {};
let traceCapacity = 470;
let range: HzRange = {minHz: 80, maxHz: 600};
let windowMs = 10_000;

// Captured at init to bridge main's performance.now() epoch (used for
// clientNowMs trace-sample timestamps) to worker's epoch (used by
// paint's rAF-driven now). Without this, worker's now() is smaller
// than main's at the same wall-clock moment by ~(worker creation
// delay), and tsMs > nowMs for every sample, drawing every trace off
// the right edge of the canvas.
let mainEpochOffsetMs = 0;

const size: CanvasSize = {width: 0, height: 0};
let hzToY = makeHzToY(range, 0);
let hzToYHeight = 0;
let rafId = 0;

const paintFrame: PaintFrame = {
    ctx: null as unknown as OffscreenCanvasRenderingContext2D,
    size,
    hzToY,
    nowMs: 0,
    windowMs,
};

function paint(): void {
    if (!canvas || !ctx) {
        return;
    }
    applyCanvasBacking(canvas, ctx, backing, size);
    if (hzToYHeight !== size.height) {
        hzToY = makeHzToY(range, size.height);
        hzToYHeight = size.height;
        paintFrame.hzToY = hzToY;
    }
    paintFrame.nowMs = performance.now() + mainEpochOffsetMs;
    paintFrame.windowMs = windowMs;
    drawBackground(paintFrame);
    drawGrid(paintFrame, range);
    drawTraces(paintFrame, voices, buffers);
    drawLegend(paintFrame, voices);
    rafId = requestAnimationFrame(paint);
}

function rebuildBuffers(): void {
    const next: Record<string, TraceBuffer> = {};
    for (const v of voices) {
        next[v.channelId] = buffers[v.channelId] ?? new TraceBuffer(traceCapacity);
    }
    buffers = next;
}

self.onmessage = (event: MessageEvent<PlotMessage>) => {
    const msg = event.data;
    switch (msg.type) {
        case 'init': {
            // Reconcile the main-thread epoch immediately on receive so
            // the offset reflects the messaging delay at startup. Error
            // bound is ~(message transit time), typically ~1 ms,
            // acceptable for visual plotting.
            mainEpochOffsetMs = msg.mainNowAtInitMs - performance.now();
            canvas = msg.canvas;
            const got = canvas.getContext('2d');
            if (!got) {
                throw new Error('plotWorker: OffscreenCanvas 2d context unavailable');
            }
            ctx = got;
            paintFrame.ctx = ctx;
            backing.cssWidth = msg.backing.cssWidth;
            backing.cssHeight = msg.backing.cssHeight;
            backing.dpr = msg.backing.dpr;
            voices = msg.voices;
            traceCapacity = msg.traceCapacity;
            range = {minHz: msg.minHz, maxHz: msg.maxHz};
            windowMs = msg.windowMs;
            rebuildBuffers();
            if (rafId === 0 && backing.cssHeight > 0) {
                rafId = requestAnimationFrame(paint);
            }

            return;
        }
        case 'setRoster': {
            voices = msg.voices;
            rebuildBuffers();

            return;
        }
        case 'setBacking': {
            backing.cssWidth = msg.cssWidth;
            backing.cssHeight = msg.cssHeight;
            backing.dpr = msg.dpr;
            if (rafId === 0 && backing.cssHeight > 0) {
                rafId = requestAnimationFrame(paint);
            }

            return;
        }
        case 'frame': {
            const buf = buffers[msg.frame.channelId];
            if (buf) {
                buf.push(msg.clientNowMs, msg.frame.fundamentalHz, msg.frame.confidence);
            }

            return;
        }
        default: {
            const _exhaustive: never = msg;
            void _exhaustive;
        }
    }
};
