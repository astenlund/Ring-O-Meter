/// <reference lib="webworker" />

import {
    applyCanvasBacking,
    drawBackground,
    drawGrid,
    drawLegend,
    drawTraces,
    drawVowelChrome,
    drawVowelDots,
    drawVowelPolygon,
    makeHzToY,
    type CanvasBacking,
    type CanvasSize,
    type HzRange,
    type PaintFrame,
    type RingsRecord,
    type VowelPoint2d,
} from './paint';
import {FrameRingReader, type FormantFrame} from '../audio/frameRing';
import {
    F1_MIN,
    F1_MAX,
    F1_SPAN,
    F2_MIN,
    F2_MAX,
    F2_SPAN,
    GateDebounce,
    MAX_VOICES,
    OrderDebounce,
    VOWEL_DIM_BRIGHTNESS,
    consumeLatestFrame,
    polarAngleSortInto,
    type VoicePoint,
} from './vowelModule';
import {hexToRgba} from './color';
import {PlotMessageType, type PlotMessage, type VoiceEntry} from './plotMessages';

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

// Vowel-side state. Mirrors the WebGPU worker's vowel module structure
// but uses paint.ts helpers + vowelModule.ts state machines directly,
// since the 2D arm has no RenderModule abstraction.
//
// heuristic: vowel-dot-css-size - dot side length in CSS pixels.
const VOWEL_DOT_CSS_SIZE = 4;

interface VowelChannelState {
    reader: FrameRingReader;
    point: VoicePoint;
    debounce: GateDebounce;
    color: string;     // cached CSS string for ctx.fillStyle / strokeStyle
    dimColor: string;  // cached CSS string at VOWEL_DIM_BRIGHTNESS
}

let vowelCanvas: OffscreenCanvas | null = null;
let vowelCtx: OffscreenCanvasRenderingContext2D | null = null;
const vowelBacking: CanvasBacking = {cssWidth: 0, cssHeight: 0, dpr: 1};
const vowelSize: CanvasSize = {width: 0, height: 0};
const vowelChannels = new Map<string, VowelChannelState>();
const vowelOrderDebounce = new OrderDebounce();
const vowelAnglesScratch = new Float64Array(MAX_VOICES);
const vowelOrderingScratch = new Int32Array(MAX_VOICES);
const vowelFormantsOut: FormantFrame = {
    f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0,
    rmsDb: 0, fundamentalHz: 0, confidence: 0,
};
// Pre-allocated VoicePoint[] primed to MAX_VOICES capacity. Reset via
// length=0 + push per frame; V8 keeps allocated capacity at the
// high-water mark so push never reallocates.
const vowelPointsScratch: VoicePoint[] = [];
// Pre-allocated VowelPoint2d objects passed to the paint helpers. One
// per voice slot up to MAX_VOICES; the helpers iterate the first N
// based on the length tracked separately.
const vowelDrawPoints: VowelPoint2d[] = [];
// Initial priming so push() never grows the arrays beyond MAX_VOICES.
for (let i = 0; i < MAX_VOICES; i++) {
    vowelPointsScratch.push({
        channelId: '',
        color: '',
        f1Hz: 0,
        f2Hz: 0,
        isDimmed: true,
        hasEverPublished: false,
    });
    vowelDrawPoints.push({
        x: 0,
        y: 0,
        color: '',
        dimColor: '',
        isDimmed: false,
    });
}
vowelPointsScratch.length = 0;
vowelDrawPoints.length = 0;

// Pre-allocated number[] used to slice `applied` (Int32Array) into a
// length-bounded ReadonlyArray<number> for the paint helpers. Primed
// to MAX_VOICES so per-frame push never grows the internal array.
const vowelOrderingForPaint: number[] = [];
for (let i = 0; i < MAX_VOICES; i++) {
    vowelOrderingForPaint.push(0);
}
vowelOrderingForPaint.length = 0;

let lastVowelFrameMs = 0;

function buildDimColorString(hex: string): string {
    const rgba = new Float32Array(4);
    hexToRgba(hex, rgba);
    const r = Math.round(rgba[0] * 255 * VOWEL_DIM_BRIGHTNESS);
    const g = Math.round(rgba[1] * 255 * VOWEL_DIM_BRIGHTNESS);
    const b = Math.round(rgba[2] * 255 * VOWEL_DIM_BRIGHTNESS);

    return `rgb(${r}, ${g}, ${b})`;
}

function paintVowel(): void {
    if (!vowelCanvas || !vowelCtx || vowelBacking.cssHeight === 0) {
        return;
    }
    applyCanvasBacking(vowelCanvas, vowelCtx, vowelBacking, vowelSize);
    const nowMs = performance.now();
    const dtMs = lastVowelFrameMs === 0 ? 0 : nowMs - lastVowelFrameMs;
    lastVowelFrameMs = nowMs;

    // Read latest formants for each attached channel; collect the
    // ones that have ever published into pointsScratch.
    vowelPointsScratch.length = 0;
    for (const voice of voices) {
        const state = vowelChannels.get(voice.channelId);
        if (!state) {
            continue;
        }
        consumeLatestFrame(state.point, state.reader, vowelFormantsOut, state.debounce, dtMs);
        if (state.point.hasEverPublished) {
            vowelPointsScratch.push(state.point);
        }
    }

    // Always paint chrome (background + gridlines + axis labels). On
    // the 2D arm chrome is painted per frame inline; the WebGPU arm
    // uses a main-thread underlay (Task 14).
    drawVowelChrome(vowelCtx, vowelSize, {min: F1_MIN, max: F1_MAX}, {min: F2_MIN, max: F2_MAX});

    const voiceCount = vowelPointsScratch.length;
    if (voiceCount === 0) {
        return;
    }

    polarAngleSortInto(vowelPointsScratch, voiceCount, vowelAnglesScratch, vowelOrderingScratch);
    vowelOrderDebounce.update(vowelOrderingScratch, voiceCount, dtMs);
    const applied = vowelOrderDebounce.getApplied();
    const appliedLen = vowelOrderDebounce.getAppliedLength();

    // Map each VoicePoint to a VowelPoint2d in the pre-allocated scratch.
    // IPA-inverted axes: high F2 = front = LEFT; high F1 = open = BOTTOM.
    // Y-axis convention matches drawVowelChrome's gridline mapping:
    //   y = height * (1 - (f1 - F1_MIN) / F1_SPAN)
    // so F1_MIN maps to y=height (bottom) and F1_MAX maps to y=0 (top).
    vowelDrawPoints.length = 0;
    for (let i = 0; i < voiceCount; i++) {
        const pt = vowelPointsScratch[i];
        const state = vowelChannels.get(pt.channelId)!;
        const x = vowelSize.width * (1 - (pt.f2Hz - F2_MIN) / F2_SPAN);
        const y = vowelSize.height * (1 - (pt.f1Hz - F1_MIN) / F1_SPAN);
        vowelDrawPoints.push({
            x,
            y,
            color: state.color,
            dimColor: state.dimColor,
            isDimmed: pt.isDimmed,
        });
    }

    const dotSizeDevicePx = Math.round(VOWEL_DOT_CSS_SIZE * vowelBacking.dpr);
    const strokeWidthDevicePx = Math.max(1, Math.round(1.5 * vowelBacking.dpr));

    // Build a contiguous number[] slice of `applied` for the paint helpers
    // (they take ReadonlyArray<number>). Uses the pre-allocated
    // vowelOrderingForPaint to stay zero-alloc; length is reset to 0 then
    // pushed up to appliedLen, keeping it in the high-water-mark region.
    vowelOrderingForPaint.length = 0;
    for (let i = 0; i < appliedLen; i++) {
        vowelOrderingForPaint.push(applied[i]);
    }

    drawVowelPolygon(vowelCtx, vowelDrawPoints, vowelOrderingForPaint, strokeWidthDevicePx);
    drawVowelDots(vowelCtx, vowelDrawPoints, dotSizeDevicePx);
}

function paint(): void {
    if (!canvas || !ctx) {
        // Canvas not yet received; re-arm and try next frame.
    } else {
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
    }

    paintVowel();

    rafId = requestAnimationFrame(paint);
}

self.onmessage = (event: MessageEvent<PlotMessage>) => {
    const msg = event.data;
    switch (msg.type) {
        case PlotMessageType.Init: {
            mainEpochOffsetMs = msg.mainNowAtInitMs - performance.now();
            canvas = msg.canvas;
            const got = canvas.getContext('2d');
            if (!got) {
                throw new Error('plotWorker2dCanvas: OffscreenCanvas 2d context unavailable');
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
        case PlotMessageType.SetRoster: {
            voices = msg.voices;

            return;
        }
        case PlotMessageType.SetBacking: {
            backing.cssWidth = msg.cssWidth;
            backing.cssHeight = msg.cssHeight;
            backing.dpr = msg.dpr;
            if (rafId === 0 && backing.cssHeight > 0) {
                rafId = requestAnimationFrame(paint);
            }

            return;
        }
        case PlotMessageType.AttachChannel: {
            rings[msg.channelId] = new FrameRingReader(msg.source.sab, msg.source.epochOffsetMs);

            return;
        }
        case PlotMessageType.DetachChannel: {
            delete rings[msg.channelId];

            return;
        }
        case PlotMessageType.RebaseChannel: {
            rings[msg.channelId]?.setOffset(msg.epochOffsetMs);

            return;
        }
        case PlotMessageType.InitVowelCanvas: {
            vowelCanvas = msg.canvas;
            const got = vowelCanvas.getContext('2d');
            if (!got) {
                throw new Error('plotWorker2dCanvas: vowel canvas 2d context unavailable');
            }
            vowelCtx = got;
            vowelBacking.cssWidth = msg.backing.cssWidth;
            vowelBacking.cssHeight = msg.backing.cssHeight;
            vowelBacking.dpr = msg.backing.dpr;

            return;
        }
        case PlotMessageType.AttachVowelChannel: {
            vowelChannels.set(msg.channelId, {
                reader: new FrameRingReader(msg.source.sab, msg.source.epochOffsetMs),
                point: {
                    channelId: msg.channelId,
                    color: msg.color,
                    f1Hz: 0,
                    f2Hz: 0,
                    isDimmed: true,
                    hasEverPublished: false,
                },
                debounce: new GateDebounce(),
                color: msg.color,
                dimColor: buildDimColorString(msg.color),
            });
            vowelOrderDebounce.reset();

            return;
        }
        case PlotMessageType.DetachVowelChannel: {
            vowelChannels.delete(msg.channelId);
            vowelOrderDebounce.reset();

            return;
        }
        case PlotMessageType.RebaseVowelChannel: {
            vowelChannels.get(msg.channelId)?.reader.setOffset(msg.epochOffsetMs);

            return;
        }
        case PlotMessageType.SetVowelBacking: {
            vowelBacking.cssWidth = msg.cssWidth;
            vowelBacking.cssHeight = msg.cssHeight;
            vowelBacking.dpr = msg.dpr;

            return;
        }
        default: {
            const _exhaustive: never = msg;
            void _exhaustive;
        }
    }
};
