import {shouldDisplayPitch} from './displayGate';
import type {TraceBuffer} from '../session/traceBuffer';

export interface VoiceStyle {
    label: string;
    color: string;
}

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
    ctx: CanvasRenderingContext2D;
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
    canvas: HTMLCanvasElement,
    ctx: CanvasRenderingContext2D,
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

export function drawTraces(
    frame: PaintFrame,
    voiceEntries: ReadonlyArray<readonly [string, VoiceStyle]>,
    buffers: Record<string, TraceBuffer>,
): void {
    const {ctx, hzToY, size, nowMs, windowMs} = frame;
    const startMs = nowMs - windowMs;

    // Iterate voices (not buffers) so legend and trace order stay in
    // sync even if a buffer exists for a channel that is no longer in
    // the voice set (or vice versa). Entries are precomputed by the
    // caller so rAF paints don't each allocate a fresh entries array.
    for (const [channelId, voice] of voiceEntries) {
        const buffer = buffers[channelId];
        ctx.strokeStyle = voice.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let pen = false;
        buffer?.forEach((tsMs, fundamentalHz, confidence) => {
            if (tsMs < startMs || !shouldDisplayPitch(fundamentalHz, confidence)) {
                pen = false;

                return;
            }
            const x = ((tsMs - startMs) / windowMs) * size.width;
            const y = hzToY(fundamentalHz);
            if (!pen) {
                ctx.moveTo(x, y);
                pen = true;
            } else {
                ctx.lineTo(x, y);
            }
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
