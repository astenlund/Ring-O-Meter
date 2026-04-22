/// <reference lib="webworker" />

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
    type RingsRecord,
} from './paint';
import {FrameRingReader} from '../session/frameRing';
import type {PlotMessage, VoiceEntry} from './plotMessages';

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
const backing: CanvasBacking = {cssWidth: 0, cssHeight: 0, dpr: 1};
let voices: ReadonlyArray<VoiceEntry> = [];
const rings: RingsRecord = {};

let range: HzRange = {minHz: 80, maxHz: 600};
let windowMs = 10_000;
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
    drawTraces(paintFrame, voices, rings);
    drawLegend(paintFrame, voices);
    rafId = requestAnimationFrame(paint);
}

self.onmessage = (event: MessageEvent<PlotMessage>) => {
    const msg = event.data;
    switch (msg.type) {
        case 'init': {
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
            range = {minHz: msg.minHz, maxHz: msg.maxHz};
            windowMs = msg.windowMs;
            if (rafId === 0 && backing.cssHeight > 0) {
                rafId = requestAnimationFrame(paint);
            }

            return;
        }
        case 'setRoster': {
            voices = msg.voices;

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
        case 'attachChannel': {
            rings[msg.channelId] = {
                reader: new FrameRingReader(msg.sab, msg.perfNowAtContextTimeZero),
            };

            return;
        }
        case 'detachChannel': {
            delete rings[msg.channelId];

            return;
        }
        case 'rebaseChannel': {
            rings[msg.channelId]?.reader.setOffset(msg.perfNowAtContextTimeZero);

            return;
        }
        default: {
            const _exhaustive: never = msg;
            void _exhaustive;
        }
    }
};
