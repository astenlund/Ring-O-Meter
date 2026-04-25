import {shouldDisplayPitch} from '../ui/displayGate';
import type {FrameRingReader} from '../audio/frameRing';

// Both 2D contexts share the surface this module uses (rect ops, stroke
// style, path ops, fillText). Typed as unions so the same helpers run
// on the main thread (CanvasRenderingContext2D) AND inside the plot
// worker (OffscreenCanvasRenderingContext2D).
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyCanvasCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// VoiceStyle + VoiceEntry are the wire shape shared with plotMessages.
// Imported for local use in drawTraces / drawLegend signatures below AND
// re-exported so callers importing from './paint' (drawTraces.test,
// paintLoop alloc test) continue to resolve them. Under
// verbatimModuleSyntax the bare re-export alone doesn't pull names into
// scope — hence the split. Type-only; no runtime import cycle with
// plotMessages (which never imports paint).
import type {VoiceStyle, VoiceEntry} from './plotMessages';
export type {VoiceStyle, VoiceEntry};

export interface HzRange {
    minHz: number;
    maxHz: number;
}

export interface CanvasSize {
    width: number;
    height: number;
}

export type HzToY = (hz: number) => number;

// Per-paint rendering context. Built once per rAF frame in PitchPlot and
// threaded through the draw helpers so they don't each take a long
// positional parameter list. Fields a particular helper doesn't need are
// simply ignored, same as in any render-pass pattern.
export interface PaintFrame {
    ctx: AnyCanvasCtx;
    size: CanvasSize;
    hzToY: HzToY;
    nowMs: number;
    windowMs: number;
}

const GRID_STEP_HZ = 50;

// CSS-pixel size + device pixel ratio, populated externally from a
// ResizeObserver (CSS size) and a matchMedia listener (DPR). Keeping this
// as pre-measured state lets paint() stay layout-read-free.
export interface CanvasBacking {
    cssWidth: number;
    cssHeight: number;
    dpr: number;
}

// Reconciles the canvas backing-store size against a pre-measured CSS
// size + DPR. Only writes canvas.width/height (and re-installs the
// transform) when the backing size actually changes, so steady-state
// paints touch no DOM-mutating properties. Fills the caller-provided
// `out` CanvasSize so rAF paints don't allocate a fresh size object.
export function applyCanvasBacking(
    canvas: AnyCanvas,
    ctx: AnyCanvasCtx,
    backing: CanvasBacking,
    out: CanvasSize,
): void {
    const backingW = Math.round(backing.cssWidth * backing.dpr);
    const backingH = Math.round(backing.cssHeight * backing.dpr);
    if (canvas.width !== backingW || canvas.height !== backingH) {
        canvas.width = backingW;
        canvas.height = backingH;
        // Resetting canvas.width/height wipes the 2d context state, so
        // re-install the DPR transform. Only paid on resize, not per frame.
        ctx.setTransform(backing.dpr, 0, 0, backing.dpr, 0, 0);
    }
    out.width = backing.cssWidth;
    out.height = backing.cssHeight;
}

// Builds a reusable Hz-to-y-pixel mapper with the log bounds captured once.
// Called once per height change (PitchPlot caches the mapper across rAF
// frames), so the per-sample hot path inside drawTraces only pays for one
// Math.log call instead of three.
export function makeHzToY(range: HzRange, height: number): HzToY {
    const logMin = Math.log(range.minHz);
    const logSpan = Math.log(range.maxHz) - logMin;

    return (hz) => height - ((Math.log(hz) - logMin) / logSpan) * height;
}

export function drawBackground(frame: PaintFrame): void {
    const {ctx, size} = frame;
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, size.width, size.height);
}

export function drawGrid(frame: PaintFrame, range: HzRange): void {
    const {ctx, hzToY, size} = frame;
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    // All grid lines share the same stroke style, so batch them into a
    // single path: one beginPath + many moveTo/lineTo + one stroke is ~11
    // fewer driver flushes per paint at the default 80-600 Hz range.
    ctx.beginPath();
    for (let f = range.minHz; f <= range.maxHz; f += GRID_STEP_HZ) {
        const y = hzToY(f);
        ctx.moveTo(0, y);
        ctx.lineTo(size.width, y);
    }
    ctx.stroke();
}

// Per-channel reader map keyed by channelId. drawTraces iterates the
// reader's window-bounded forEach directly; the inner `tsMs < startMs`
// guard handles the pre-window interpolation path so the leading
// segment connects to x=0 instead of breaking.
export type RingsRecord = Record<string, FrameRingReader>;

export function drawTraces(
    frame: PaintFrame,
    voices: ReadonlyArray<VoiceEntry>,
    rings: RingsRecord,
): void {
    const {ctx, hzToY, size, nowMs, windowMs} = frame;
    const startMs = nowMs - windowMs;

    // Iterate voices (not rings) so legend and trace order stay in
    // sync even if a ring exists for a channel that is no longer in
    // the voice set (or vice versa).
    for (const voice of voices) {
        const reader = rings[voice.channelId];
        ctx.strokeStyle = voice.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let pen = false;
        // Last displayable-but-pre-window sample; used to interpolate a
        // moveTo at the window's left edge when the next sample lands
        // in-window, so the leading segment connects to x=0 instead of
        // breaking.
        let prevTsMs = 0;
        let prevHz = 0;
        let prevPreWindow = false;
        reader?.forEach(startMs, (tsMs, fundamentalHz, confidence) => {
            if (!shouldDisplayPitch(fundamentalHz, confidence)) {
                pen = false;
                prevPreWindow = false;

                return;
            }
            if (tsMs < startMs) {
                pen = false;
                prevTsMs = tsMs;
                prevHz = fundamentalHz;
                prevPreWindow = true;

                return;
            }
            const x = ((tsMs - startMs) / windowMs) * size.width;
            const y = hzToY(fundamentalHz);
            if (!pen) {
                if (prevPreWindow && tsMs > prevTsMs) {
                    // Interpolate y at x=0 (tsMs=startMs) between the last
                    // pre-window sample and this in-window one. Linear in
                    // screen-y, which matches what lineTo would draw if
                    // the segment had not been clipped.
                    const t = (startMs - prevTsMs) / (tsMs - prevTsMs);
                    const yPrev = hzToY(prevHz);
                    ctx.moveTo(0, yPrev + (y - yPrev) * t);
                    ctx.lineTo(x, y);
                } else {
                    ctx.moveTo(x, y);
                }
                pen = true;
            } else {
                ctx.lineTo(x, y);
            }
            prevPreWindow = false;
        });
        ctx.stroke();
    }
}

export function drawLegend(frame: PaintFrame, voiceValues: ReadonlyArray<VoiceStyle>): void {
    const {ctx} = frame;
    let legendY = 12;
    ctx.font = '12px sans-serif';
    for (const voice of voiceValues) {
        ctx.fillStyle = voice.color;
        ctx.fillRect(8, legendY - 8, 12, 12);
        ctx.fillStyle = '#ccc';
        ctx.fillText(voice.label, 26, legendY + 2);
        legendY += 18;
    }
}
