/// <reference lib="webworker" />

import {
    applyCanvasBacking,
    drawBackground,
    drawGrid,
    drawLegend,
    drawTraces,
    drawVowelChrome,
    drawVowelDots,
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

// Chrome bitmap cache. drawVowelChrome's output (background fill + 16
// gridlines + 2 axis labels = ~17 ctx ops) is pixel-identical across
// frames except on backing/range change, so caching it to an
// OffscreenCanvas and blitting via drawImage replaces ~17 ops/frame
// with one. The bitmap includes the background fill, so blitting also
// clears the canvas (preserving the previous "fillRect first" semantics
// that prevent polygon/dot ghost-trail accumulation - polygon and dots
// then paint on top per usual). Cache key is (width, height, dpr); the
// F1/F2 ranges are constants today so they're not in the key, but
// would join it if either becomes dynamic.
let vowelChromeCache: OffscreenCanvas | null = null;
let vowelChromeCacheWidth = 0;
let vowelChromeCacheHeight = 0;
let vowelChromeCacheDpr = 0;

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
// these slots IN PLACE (`vowelDrawPoints[i].x = ...`) and the helpers
// receive an explicit voiceCount (drawVowelDots) or read appliedLen
// from the ordering buffer (drawVowelPolygon). The array's `.length`
// is NEVER mutated after module init: setting `length = voiceCount`
// per frame would delete pre-allocated slots beyond voiceCount per JS
// semantics, and a subsequent frame with a larger voiceCount would
// read undefined at those indices. Module-init priming below
// populates all MAX_VOICES slots and leaves `length = MAX_VOICES`,
// where it stays for the worker's lifetime.
const vowelDrawPoints: VowelPoint2d[] = [];
// Initial priming. vowelPointsScratch + vowelOrderingForPaint use the
// push-per-frame pattern (length=0 at module init is correct, push
// re-grows up to MAX_VOICES); vowelDrawPoints uses index-assignment
// per frame so its length must stay at MAX_VOICES post-priming.
for (let i = 0; i < MAX_VOICES; i++) {
    vowelPointsScratch.push({
        channelId: '',
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

// Per-edge gradient cache. Each frame, drawVowelPolygon would
// otherwise allocate one CanvasGradient + two addColorStop entries
// per edge in Chromium's renderer-process C++ heap (the JS-heap alloc
// test doesn't observe these but they are real driver work). The
// gradient at edge slot `i` is reusable across frames as long as both
// endpoints' (x, y) and effective stroke colors are unchanged. The
// OrderDebounce keeps the edge-slot to voice-pair mapping stable
// across frames, so when singers hold a vowel the cache hit rate
// stays high; on a polygon morph the comparison falls through and
// rebuilds only the dirty slots.
//
// Layout: gradients[] holds one slot per edge (parallel to the
// ordering buffer's MAX_VOICES capacity). keyCoords stores the four
// endpoint coordinates per slot in a packed Float64Array (4 * MAX_VOICES
// numbers) so reads stay typed-array fast. keyColor0/keyColor1 hold
// the resolved CSS color strings (post-isDimmed selection) so a state
// flip from non-dimmed to dimmed at a slot triggers a rebuild even
// when (x, y) is unchanged.
const vowelEdgeGradients: (CanvasGradient | null)[] = new Array<CanvasGradient | null>(MAX_VOICES).fill(null);
const vowelEdgeCoordKeys = new Float64Array(MAX_VOICES * 4);
const vowelEdgeColor0Keys: string[] = new Array<string>(MAX_VOICES).fill('');
const vowelEdgeColor1Keys: string[] = new Array<string>(MAX_VOICES).fill('');

// Mirror of drawVowelPolygon (paint.ts) with per-edge gradient
// caching. The pure paint.ts version is retained so source-adjacent
// alloc tests can validate the underlying canvas API behavior; the
// worker uses this cached path because frame-rate is the actual hot
// surface that benefits from gradient pooling.
function drawVowelPolygonWithCache(
    ctx: OffscreenCanvasRenderingContext2D,
    points: ReadonlyArray<VowelPoint2d>,
    ordering: ArrayLike<number>,
    strokeWidthDevicePx: number,
): void {
    const n = ordering.length;
    if (n < 2) {
        return;
    }
    ctx.lineWidth = strokeWidthDevicePx;
    for (let i = 0; i < n; i++) {
        const a = points[ordering[i]];
        const b = points[ordering[(i + 1) % n]];
        const colorA = a.isDimmed ? a.dimColor : a.color;
        const colorB = b.isDimmed ? b.dimColor : b.color;
        const k = i * 4;
        let grad = vowelEdgeGradients[i];
        if (grad === null
            || vowelEdgeCoordKeys[k] !== a.x
            || vowelEdgeCoordKeys[k + 1] !== a.y
            || vowelEdgeCoordKeys[k + 2] !== b.x
            || vowelEdgeCoordKeys[k + 3] !== b.y
            || vowelEdgeColor0Keys[i] !== colorA
            || vowelEdgeColor1Keys[i] !== colorB) {
            grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
            grad.addColorStop(0, colorA);
            grad.addColorStop(1, colorB);
            vowelEdgeGradients[i] = grad;
            vowelEdgeCoordKeys[k] = a.x;
            vowelEdgeCoordKeys[k + 1] = a.y;
            vowelEdgeCoordKeys[k + 2] = b.x;
            vowelEdgeCoordKeys[k + 3] = b.y;
            vowelEdgeColor0Keys[i] = colorA;
            vowelEdgeColor1Keys[i] = colorB;
        }
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    }
}

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

// Returns the chrome bitmap, rebuilding it if backing dimensions or
// dpr have changed since the last build. Returns null if the cache
// cannot be (re)created (no canvas yet, zero-sized backing, or
// 2D context unavailable on the cache); callers fall back to a
// per-frame drawVowelChrome path in that branch.
function ensureVowelChromeCache(): OffscreenCanvas | null {
    if (vowelSize.width === 0 || vowelSize.height === 0) {
        return null;
    }
    const dpr = vowelBacking.dpr;
    const wantWidth = vowelSize.width;
    const wantHeight = vowelSize.height;
    if (vowelChromeCache !== null
        && vowelChromeCacheWidth === wantWidth
        && vowelChromeCacheHeight === wantHeight
        && vowelChromeCacheDpr === dpr) {
        return vowelChromeCache;
    }
    // Cache canvas is sized in device pixels to match destination's
    // backing-store; dpr is then applied to its context so chrome
    // draws in CSS-pixel coordinates (matching the vowelCtx state
    // post-applyCanvasBacking).
    if (vowelChromeCache === null) {
        vowelChromeCache = new OffscreenCanvas(wantWidth * dpr, wantHeight * dpr);
    } else {
        vowelChromeCache.width = wantWidth * dpr;
        vowelChromeCache.height = wantHeight * dpr;
    }
    const cacheCtx = vowelChromeCache.getContext('2d');
    if (!cacheCtx) {
        return null;
    }
    cacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawVowelChrome(cacheCtx, vowelSize, {min: F1_MIN, max: F1_MAX}, {min: F2_MIN, max: F2_MAX});
    vowelChromeCacheWidth = wantWidth;
    vowelChromeCacheHeight = wantHeight;
    vowelChromeCacheDpr = dpr;

    return vowelChromeCache;
}

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

    // Chrome (background fill + gridlines + axis labels) is cached in
    // a separate OffscreenCanvas and blitted per frame; the cache is
    // rebuilt only when backing dimensions or dpr change. Falls back
    // to a per-frame drawVowelChrome if the cache cannot be built
    // (e.g. degenerate sizing). The blit's source size is in device
    // pixels (the cache's storage) and the dest size is in CSS pixels
    // (matching vowelCtx's post-scale coordinate space). The WebGPU
    // arm uses a parallel underlay-canvas pattern managed on the main
    // thread by PlotController; this worker-local cache is the 2D
    // arm's equivalent.
    const cache = ensureVowelChromeCache();
    if (cache !== null) {
        vowelCtx.drawImage(cache,
            0, 0, cache.width, cache.height,
            0, 0, vowelSize.width, vowelSize.height);
    } else {
        drawVowelChrome(vowelCtx, vowelSize, {min: F1_MIN, max: F1_MAX}, {min: F2_MIN, max: F2_MAX});
    }

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

    drawVowelPolygonWithCache(vowelCtx, vowelDrawPoints, vowelOrderingForPaint, strokeWidthDevicePx);
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
            voices = msg.voices;
            range = {minHz: msg.minHz, maxHz: msg.maxHz};
            windowMs = msg.windowMs;
            // rAF arms via the SetBacking handler that follows; no backing
            // dims are known yet at Init.

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
            // rAF arms via the SetVowelBacking (or trace's SetBacking)
            // handler that follows; no backing dims are known yet at
            // InitVowelCanvas.

            return;
        }
        case PlotMessageType.AttachVowelChannel: {
            vowelChannels.set(msg.channelId, {
                reader: new FrameRingReader(msg.source.sab, msg.source.epochOffsetMs),
                point: {
                    channelId: msg.channelId,
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
        case PlotMessageType.InitChordBarsCanvas:
        case PlotMessageType.SetChordBarsBacking:
        case PlotMessageType.SetChordClassification:
            // Task 18 wires the real handlers; stubs here keep the exhaustiveness
            // check happy across intermediate commits.
            return;
        default: {
            const _exhaustive: never = msg;
            void _exhaustive;
        }
    }
};
