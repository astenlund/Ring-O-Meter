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
    type RingsRecord,
    type VoiceEntry,
} from '../plot/paint';
import {createFrameRing, FrameRingReader, FrameRingWriter} from '../audio/frameRing';

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
        const sabA = createFrameRing();
        const sabB = createFrameRing();
        const writerA = new FrameRingWriter(sabA);
        const writerB = new FrameRingWriter(sabB);
        const rings: RingsRecord = {
            a: new FrameRingReader(sabA, 0),
            b: new FrameRingReader(sabB, 0),
        };
        const baseMs = performance.now();
        // Setup loop runs before the warmup baseline gc(), so its
        // per-iteration object literals do not contribute to the budget
        // that measures paint() below; readability beats scratch
        // hoisting here.
        for (let i = 0; i < 470; i += 1) {
            const ts = baseMs + i * 21;
            const hzA = 220 + Math.sin(i * 0.1) * 10;
            const hzB = 440 + Math.sin(i * 0.1) * 10;
            writerA.publish({captureContextMs: ts, fundamentalHz: hzA, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: hzA});
            writerB.publish({captureContextMs: ts, fundamentalHz: hzB, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: hzB});
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
            drawTraces(frame, voices, rings);
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
