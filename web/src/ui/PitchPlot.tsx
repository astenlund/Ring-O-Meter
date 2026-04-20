import {type RefObject, useEffect, useRef} from 'react';
import {
    applyCanvasBacking,
    drawBackground,
    drawGrid,
    drawLegend,
    drawTraces,
    makeHzToY,
    type CanvasBacking,
    type CanvasSize,
    type PaintFrame,
    type VoiceEntry,
    type VoiceStyle,
} from './pitchPlotPaint';
import type {TraceBuffer} from '../session/traceBuffer';

export type {VoiceEntry, VoiceStyle};

export interface PitchPlotProps {
    voices: ReadonlyArray<VoiceEntry>;           // flat roster: style + channelId
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

        const range = {minHz, maxHz};
        // Scratch structures reused across rAF frames so the paint loop
        // allocates nothing in steady state: `size` is mutated by
        // applyCanvasBacking; `frame` fields are overwritten before each
        // helper reads them; `emptyBuffers` is a stable sentinel for the
        // (defensive) null-ref fallback.
        const emptyBuffers: Record<string, TraceBuffer> = {};
        const size: CanvasSize = {width: 0, height: 0};
        // hzToY depends only on range (constant here) and size.height,
        // which changes only on resize. Invalidate with a height sentinel
        // so steady-state paints reuse the same closure. Initialised
        // against size.height=0 as a throwaway: the first paint() runs
        // only once layout has reported a non-zero height, at which point
        // the sentinel mismatch forces a rebuild before anything renders.
        let hzToY = makeHzToY(range, size.height);
        let hzToYHeight = size.height;
        const frame: PaintFrame = {ctx, size, hzToY, nowMs: 0, windowMs};
        let rafId = 0;

        const paint = () => {
            applyCanvasBacking(canvas, ctx, backing, size);
            if (hzToYHeight !== size.height) {
                hzToY = makeHzToY(range, size.height);
                hzToYHeight = size.height;
                frame.hzToY = hzToY;
            }
            frame.nowMs = performance.now();
            drawBackground(frame);
            drawGrid(frame, range);
            drawTraces(frame, voices, buffersRef.current ?? emptyBuffers);
            drawLegend(frame, voices);

            rafId = requestAnimationFrame(paint);
        };

        // Schedules the paint loop. Skips while the canvas has no layout
        // height: painting then would build hzToY against height=0 and
        // collapse every trace to the top edge until the observer fires
        // with the real size. Called on effect entry (fast path) and from
        // the ResizeObserver (once layout produces a usable height).
        const startPaint = () => {
            if (rafId !== 0 || backing.cssHeight <= 0) {
                return;
            }
            rafId = requestAnimationFrame(paint);
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
            startPaint();
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

        startPaint();

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
