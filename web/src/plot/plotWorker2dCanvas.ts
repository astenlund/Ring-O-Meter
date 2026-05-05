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
    VOWEL_DOT_CSS_SIZE,
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
// per voice slot up to MAX_VOICES; the per-frame paint loop mutates
// these slots IN PLACE (`vowelDrawPoints[i].x = ...`) and then sets
// `length = voiceCount` to bound the helpers' iteration. The module-
// init priming below populates all MAX_VOICES slots and leaves
// `length = MAX_VOICES`. Do NOT reset the length to 0 here -- that
// would destroy the pre-allocated objects, and the first per-frame
// `vowelDrawPoints[i].x = ...` would throw on `undefined.x`. The
// per-frame `length = voiceCount` line in paintVowel handles the
// runtime-visible length.
const vowelDrawPoints: VowelPoint2d[] = [];
// Initial priming. vowelPointsScratch + vowelOrderingForPaint use the
// push-per-frame pattern (length=0 at module init is correct, push
// re-grows up to MAX_VOICES); vowelDrawPoints uses index-assignment
// per frame so its length must stay at MAX_VOICES post-priming.
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
// vowelDrawPoints.length intentionally stays at MAX_VOICES; see comment above.

// Pre-allocated number[] used to expose a length-bounded view of
// `applied` (Int32Array, full MAX_VOICES capacity) to the paint
// helpers. drawVowelPolygon accepts ArrayLike<number> so it could
// take an Int32Array directly, but the only length-bounded handle
// the Int32Array offers is `subarray(0, appliedLen)` which allocates
// a fresh view object per frame (~100 B × 60 fps × 60 s blows the
// vowel-module alloc-test budget). Push-into-primed-array stays
// zero-alloc in steady state because V8 keeps the internal capacity
// at the high-water mark after `length = 0`.
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
    // IPA-inverted axes: high F2 = front = LEFT; high F1 = open = BOTTOM,
    // low F1 = close = TOP. F2 needs the (1 - xNorm) inversion because
    // canvas x grows left-to-right; F1 does NOT need the (1 - yNorm)
    // inversion because canvas y already grows top-to-bottom, so plain
    // yNorm puts low F1 (small numerator) near the top automatically.
    //
    // Mutate pre-allocated slots in place (do NOT push fresh objects):
    // vowelDrawPoints was primed with MAX_VOICES placeholders at module
    // load so per-frame writes only update field values, keeping the
    // per-frame paint zero-alloc per the hot-path-allocation-discipline
    // pattern.
    for (let i = 0; i < voiceCount; i++) {
        const pt = vowelPointsScratch[i];
        const state = vowelChannels.get(pt.channelId)!;
        const slot = vowelDrawPoints[i];
        slot.x = vowelSize.width * (1 - (pt.f2Hz - F2_MIN) / F2_SPAN);
        slot.y = vowelSize.height * ((pt.f1Hz - F1_MIN) / F1_SPAN);
        slot.color = state.color;
        slot.dimColor = state.dimColor;
        slot.isDimmed = pt.isDimmed;
    }
    // vowelDrawPoints.length intentionally stays at MAX_VOICES; the
    // paint helpers below take an explicit voiceCount/appliedLen rather
    // than relying on the array's length. Truncating here would delete
    // the slots beyond voiceCount per JS semantics, and the next frame
    // with a larger voiceCount would read undefined at those indices.

    const dotSizeDevicePx = Math.round(VOWEL_DOT_CSS_SIZE * vowelBacking.dpr);
    const strokeWidthDevicePx = Math.max(1, Math.round(1.5 * vowelBacking.dpr));

    // Push the first appliedLen entries from `applied` (Int32Array,
    // capacity MAX_VOICES) into the primed number[] buffer. See
    // declaration comment for why subarray is the wrong choice here.
    vowelOrderingForPaint.length = 0;
    for (let i = 0; i < appliedLen; i++) {
        vowelOrderingForPaint.push(applied[i]);
    }

    drawVowelPolygon(vowelCtx, vowelDrawPoints, vowelOrderingForPaint, strokeWidthDevicePx);
    drawVowelDots(vowelCtx, vowelDrawPoints, voiceCount, dotSizeDevicePx);
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
            // Arm the rAF loop here too so a vowel-only mount (no
            // PitchPlot) still paints. The trace's Init / SetBacking
            // handlers also arm rAF; the guard ensures only one arming
            // per worker lifetime.
            if (rafId === 0 && vowelBacking.cssHeight > 0) {
                rafId = requestAnimationFrame(paint);
            }

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
            if (rafId === 0 && vowelBacking.cssHeight > 0) {
                rafId = requestAnimationFrame(paint);
            }

            return;
        }
        default: {
            const _exhaustive: never = msg;
            void _exhaustive;
        }
    }
};
