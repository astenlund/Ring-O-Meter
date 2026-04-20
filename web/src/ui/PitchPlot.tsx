import {type RefObject, useEffect, useRef} from 'react';
import {
    applyCanvasBacking,
    drawBackground,
    drawGrid,
    drawLegend,
    drawTraces,
    makeHzToY,
    type CanvasBacking,
    type PaintFrame,
    type VoiceStyle,
} from './pitchPlotPaint';
import type {TraceBuffer} from '../session/traceBuffer';

export type {VoiceStyle};

export interface PitchPlotProps {
    voices: Record<string, VoiceStyle>;          // channelId -> label + color
    buffersRef: RefObject<Record<string, TraceBuffer>>;
    windowMs: number;                            // rolling display window
    minHz?: number;                              // default 80
    maxHz?: number;                              // default 600
}

export function PitchPlot({
    voices,
    buffersRef,
    windowMs,
    minHz = 80,
    maxHz = 600,
}: PitchPlotProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // The trace buffer updates at the worklet's publish rate (~47 Hz per
    // voice). Painting once per animation frame (<=60 Hz, zero when the tab
    // is hidden) decouples the paint rate from publish rate and lets the
    // browser coalesce work with other rendering. The loop reads buffersRef
    // directly so trace pushes don't need to cause React re-renders.
    //
    // CSS size and DPR are tracked outside the paint loop (ResizeObserver +
    // matchMedia) so paint() never reads clientWidth/clientHeight: those
    // reads are layout-synchronous and at 60 fps add up to a steady stream
    // of avoidable layout work.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

        const backing: CanvasBacking = {
            cssWidth: canvas.clientWidth,
            cssHeight: canvas.clientHeight,
            dpr: window.devicePixelRatio || 1,
        };

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) {
                return;
            }
            const box = entry.contentBoxSize?.[0];
            if (box) {
                backing.cssWidth = box.inlineSize;
                backing.cssHeight = box.blockSize;
            } else {
                backing.cssWidth = entry.contentRect.width;
                backing.cssHeight = entry.contentRect.height;
            }
        });
        observer.observe(canvas);

        // A `(resolution: Xdppx)` media query only fires when DPR LEAVES X,
        // so after each change we have to re-arm against the new value.
        // This catches both user zoom and monitor swaps (laptop <-> external).
        let mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        const onDprChange = () => {
            backing.dpr = window.devicePixelRatio || 1;
            mql.removeEventListener('change', onDprChange);
            mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
            mql.addEventListener('change', onDprChange);
        };
        mql.addEventListener('change', onDprChange);

        const range = {minHz, maxHz};
        let rafId = 0;

        const paint = () => {
            const size = applyCanvasBacking(canvas, ctx, backing);
            const frame: PaintFrame = {
                ctx,
                size,
                hzToY: makeHzToY(range, size.height),
                nowMs: performance.now(),
                windowMs,
            };
            drawBackground(frame);
            drawGrid(frame, range);
            drawTraces(frame, voices, buffersRef.current ?? {});
            drawLegend(frame, voices);

            rafId = requestAnimationFrame(paint);
        };

        rafId = requestAnimationFrame(paint);

        return () => {
            cancelAnimationFrame(rafId);
            observer.disconnect();
            mql.removeEventListener('change', onDprChange);
        };
    }, [voices, buffersRef, windowMs, minHz, maxHz]);

    return (
        <canvas
            ref={canvasRef}
            style={{width: '100%', height: 360, borderRadius: 6, border: '1px solid #444'}}
        />
    );
}
