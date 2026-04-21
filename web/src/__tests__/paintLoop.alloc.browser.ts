import {describe, test, expect} from 'vitest';
import {
    applyCanvasBacking,
    drawBackground,
    drawGrid,
    drawLegend,
    drawTraces,
    makeHzToY,
    type CanvasBacking,
    type CanvasSize,
    type HzRange,
    type PaintFrame,
    type VoiceEntry,
} from '../plot/paint';
import {TraceBuffer} from '../session/traceBuffer';

declare global {
    var gc: (() => void) | undefined;
}

interface PerformanceWithMemory extends Performance {
    memory?: {usedJSHeapSize: number};
}

const HEAP_DELTA_BUDGET_BYTES = 50 * 1024;
const PAINT_ITERATIONS = 10_000;
const WARMUP_ITERATIONS = 500;

describe('paint loop allocation budget', () => {
    test(`${PAINT_ITERATIONS} paints leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB above warmup baseline`, () => {
        const perfMem = performance as PerformanceWithMemory;
        if (!globalThis.gc || !perfMem.memory) {
            throw new Error('Test requires Chromium launched with --js-flags="--expose-gc"');
        }

        const canvas = document.createElement('canvas');
        canvas.style.width = '800px';
        canvas.style.height = '360px';
        document.body.appendChild(canvas);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('2d context unavailable');
        }
        const backing: CanvasBacking = {cssWidth: 800, cssHeight: 360, dpr: 1};
        const size: CanvasSize = {width: 0, height: 0};
        const range: HzRange = {minHz: 80, maxHz: 600};
        const voices: ReadonlyArray<VoiceEntry> = [
            {channelId: 'a', label: 'Voice 1', color: '#5cf'},
            {channelId: 'b', label: 'Voice 2', color: '#fc5'},
        ];
        const buffers: Record<string, TraceBuffer> = {
            a: new TraceBuffer(470),
            b: new TraceBuffer(470),
        };
        const baseMs = performance.now();
        for (let i = 0; i < 470; i += 1) {
            const ts = baseMs + i * 21;
            buffers.a.push(ts, 220 + Math.sin(i * 0.1) * 10, 0.9);
            buffers.b.push(ts, 440 + Math.sin(i * 0.1) * 10, 0.9);
        }

        let hzToY = makeHzToY(range, 360);
        let hzToYHeight = 360;
        const frame: PaintFrame = {ctx, size, hzToY, nowMs: 0, windowMs: 10_000};
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
            drawTraces(frame, voices, buffers);
            drawLegend(frame, voices);
        };

        for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
            paint();
        }
        globalThis.gc();
        const baseline = perfMem.memory.usedJSHeapSize;

        for (let i = 0; i < PAINT_ITERATIONS; i += 1) {
            paint();
        }
        globalThis.gc();
        const after = perfMem.memory.usedJSHeapSize;

        expect(after - baseline).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);
    });
});
