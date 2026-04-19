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

export function drawBackground(ctx: CanvasRenderingContext2D, size: CanvasSize): void {
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, size.width, size.height);
}

export function drawGrid(ctx: CanvasRenderingContext2D, range: HzRange, size: CanvasSize): void {
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    for (let f = range.minHz; f <= range.maxHz; f += 50) {
        const y = hzToY(f, range, size.height);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size.width, y);
        ctx.stroke();
    }
}

export function drawTraces(
    ctx: CanvasRenderingContext2D,
    voices: Record<string, VoiceStyle>,
    samples: Record<string, TraceSample[]>,
    windowMs: number,
    nowMs: number,
    range: HzRange,
    size: CanvasSize,
): void {
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
            const y = hzToY(s.fundamentalHz, range, size.height);
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

export function drawLegend(ctx: CanvasRenderingContext2D, voices: Record<string, VoiceStyle>): void {
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

export function hzToY(hz: number, range: HzRange, height: number): number {
    const logMin = Math.log(range.minHz);
    const logMax = Math.log(range.maxHz);
    const t = (Math.log(hz) - logMin) / (logMax - logMin);

    return height - t * height;
}
