import {type RefObject, useEffect, useRef} from 'react';
import {
    drawBackground,
    drawGrid,
    drawLegend,
    drawTraces,
    resizeForDpr,
    type TraceSample,
    type VoiceStyle,
} from './pitchPlotPaint';

export type {TraceSample, VoiceStyle};

export interface PitchPlotProps {
    voices: Record<string, VoiceStyle>;          // channelId -> label + color
    samplesRef: RefObject<Record<string, TraceSample[]>>;
    windowMs: number;                            // rolling display window
    minHz?: number;                              // default 80
    maxHz?: number;                              // default 600
}

export function PitchPlot({
    voices,
    samplesRef,
    windowMs,
    minHz = 80,
    maxHz = 600,
}: PitchPlotProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // The trace buffer updates at the worklet's publish rate (~47 Hz per
    // voice). Painting once per animation frame (<=60 Hz, zero when the tab
    // is hidden) decouples the paint rate from publish rate and lets the
    // browser coalesce work with other rendering. The loop reads samplesRef
    // directly so trace pushes don't need to cause React re-renders.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

        const range = {minHz, maxHz};
        let rafId = 0;

        const paint = () => {
            const size = resizeForDpr(canvas, ctx);
            drawBackground(ctx, size);
            drawGrid(ctx, range, size);
            drawTraces(ctx, voices, samplesRef.current ?? {}, windowMs, performance.now(), range, size);
            drawLegend(ctx, voices);

            rafId = requestAnimationFrame(paint);
        };

        rafId = requestAnimationFrame(paint);

        return () => cancelAnimationFrame(rafId);
    }, [voices, samplesRef, windowMs, minHz, maxHz]);

    return (
        <canvas
            ref={canvasRef}
            style={{width: '100%', height: 360, borderRadius: 6, border: '1px solid #444'}}
        />
    );
}
