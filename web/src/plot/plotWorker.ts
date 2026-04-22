/// <reference lib="webworker" />

// PlotController always posts `init` before any other message from
// the same main-thread tick it was constructed in; structured-clone
// ordering guarantees `init` arrives first at the worker. Keep that
// invariant.

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
import {createFrameRing, FrameRingReader, FrameRingWriter} from '../session/frameRing';
import type {PlotMessage, VoiceEntry} from './plotMessages';

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
const backing: CanvasBacking = {cssWidth: 0, cssHeight: 0, dpr: 1};
let voices: ReadonlyArray<VoiceEntry> = [];

// Bridge phase: worker owns BOTH sides of each ring. 'frame'
// messages are routed from the writer into the SAB; paint reads via
// the reader. Task 7 replaces this with main-owned writers and
// SAB-transit AttachChannelMessages.
interface ChannelRing {
    writer: FrameRingWriter;
    reader: FrameRingReader;
}
let rings: Record<string, ChannelRing> = {};

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

function buildRing(): ChannelRing {
    // Bridge-phase ring: reader offset is zero because paint's nowMs
    // and frames' clientNowMs are both in main's performance.now()
    // epoch already. When Task 7 moves stamping to the audio thread
    // the reader's offset will carry the AudioContext-to-
    // performance.now() reconciliation.
    const sab = createFrameRing();

    return {
        writer: new FrameRingWriter(sab),
        reader: new FrameRingReader(sab, 0),
    };
}

function rebuildRings(): void {
    const next: Record<string, ChannelRing> = {};
    for (const v of voices) {
        // Reuse the ring if the channel persisted across a roster
        // change (slot reconfig swaps channelIds today, so this path
        // is rarely hit; left in for symmetry).
        next[v.channelId] = rings[v.channelId] ?? buildRing();
    }
    rings = next;
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
            rebuildRings();
            if (rafId === 0 && backing.cssHeight > 0) {
                rafId = requestAnimationFrame(paint);
            }

            return;
        }
        case 'setRoster': {
            voices = msg.voices;
            rebuildRings();

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
            const ring = rings[msg.frame.channelId];
            if (ring) {
                ring.writer.publish(msg.clientNowMs, msg.frame.fundamentalHz, msg.frame.confidence);
            }

            return;
        }
        default: {
            const _exhaustive: never = msg;
            void _exhaustive;
        }
    }
};
