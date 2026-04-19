import {MIN_DISPLAY_CONFIDENCE} from './formatPitch';

export interface TraceSample {
    tsMs: number;
    fundamentalHz: number;
    confidence: number;
}

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
}

const GRID_STEP_HZ = 50;

// Matches the canvas backing-store size to its CSS size scaled by devicePixelRatio,
// then installs a transform so callers can draw in CSS pixels. Returns the CSS size
// so callers don't re-read clientWidth/Height.
export function resizeForDpr(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): CanvasSize {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    return {width, height};
}

// Builds a reusable Hz-to-y-pixel mapper with the log bounds captured once.
// Called once per paint (range and height are fixed across the frame), so the
// per-sample hot path inside drawTraces only pays for one Math.log call instead
// of three.
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
    for (let f = range.minHz; f <= range.maxHz; f += GRID_STEP_HZ) {
        const y = hzToY(f);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size.width, y);
        ctx.stroke();
    }
}

export function drawTraces(
    frame: PaintFrame,
    voices: Record<string, VoiceStyle>,
    samples: Record<string, TraceSample[]>,
    windowMs: number,
): void {
    const {ctx, hzToY, size, nowMs} = frame;
    const startMs = nowMs - windowMs;

    // Iterate voices (not samples) so legend and trace order stay in
    // sync even if a sample buffer exists for a channel that is no
    // longer in the voice set (or vice versa).
    for (const [channelId, voice] of Object.entries(voices)) {
        const trace = samples[channelId] ?? [];
        ctx.strokeStyle = voice.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        let pen = false;
        for (const s of trace) {
            if (s.tsMs < startMs || s.fundamentalHz <= 0 || s.confidence < MIN_DISPLAY_CONFIDENCE) {
                pen = false;
                continue;
            }
            const x = ((s.tsMs - startMs) / windowMs) * size.width;
            const y = hzToY(s.fundamentalHz);
            if (!pen) {
                ctx.moveTo(x, y);
                pen = true;
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
    }
}

export function drawLegend(frame: PaintFrame, voices: Record<string, VoiceStyle>): void {
    const {ctx} = frame;
    let legendY = 12;
    ctx.font = '12px sans-serif';
    for (const voice of Object.values(voices)) {
        ctx.fillStyle = voice.color;
        ctx.fillRect(8, legendY - 8, 12, 12);
        ctx.fillStyle = '#ccc';
        ctx.fillText(voice.label, 26, legendY + 2);
        legendY += 18;
    }
}
