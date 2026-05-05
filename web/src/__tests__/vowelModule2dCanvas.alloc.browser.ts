import {describe, expect, test} from 'vitest';
import {drawVowelChrome, drawVowelDots, drawVowelPolygon} from '../plot/paint';
import type {CanvasSize, VowelPoint2d} from '../plot/paint';

interface PerformanceWithMemory extends Performance {
    memory?: {usedJSHeapSize: number};
}

// Calibrated 2026-05-04: 4 consecutive smoke-runs (1000 paints each)
// measured a JS heap delta of approximately zero (the first run logged
// -5112 bytes; subsequent runs all passed against budget=0, confirming
// reliable non-positive delta). The 2D canvas API's per-frame
// allocations (createLinearGradient, internal path objects, fillStyle
// string parses) live in Chromium's renderer-process C++ heap, NOT
// the JS heap that performance.memory.usedJSHeapSize reports - so the
// test harness sees zero JS-side leakage from these helpers, matching
// the design (the helpers are pure 2D ctx calls with no JS object
// literals, closure allocations, or array methods on the hot path).
//
// The 8 KB budget catches real regressions (someone introducing a
// per-frame JSON.stringify, an array spread, etc.) while tolerating
// V8 GC noise riding on top of the zero baseline. Precedent: the
// frameRing reader-side budget of 4 KB documents a similar
// "provably zero-alloc" shape; this test runs more numerous canvas
// ops so a slightly wider band absorbs the extra noise.
const HEAP_DELTA_BUDGET_BYTES = 8 * 1024;
const PAINT_ITERATIONS = 1_000;
const WARMUP_ITERATIONS = 200;

describe('Vowel module 2D paint allocation budget', () => {
    test(`${PAINT_ITERATIONS} paints leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB`, async () => {
        // Arrange
        const perfMem = performance as PerformanceWithMemory;
        if (!globalThis.gc || !perfMem.memory) {
            throw new Error('Test requires Chromium launched with --js-flags="--expose-gc"');
        }

        const canvas = new OffscreenCanvas(360, 360);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('OffscreenCanvas 2D context unavailable');
        }
        const size: CanvasSize = {width: 360, height: 360};

        // 4 voices laid out in the F1/F2 plane. Pre-computed dimColors so
        // per-frame paint never re-parses hex.
        const points: VowelPoint2d[] = [
            {x: 200, y: 100, color: '#5cf', dimColor: 'rgb(43, 102, 128)', isDimmed: false},
            {x: 100, y: 200, color: '#fc5', dimColor: 'rgb(128, 102, 43)', isDimmed: false},
            {x: 250, y: 250, color: '#5f9', dimColor: 'rgb(43, 128, 77)', isDimmed: false},
            {x: 150, y: 150, color: '#f5c', dimColor: 'rgb(128, 43, 102)', isDimmed: false},
        ];
        const ordering: ReadonlyArray<number> = [0, 1, 2, 3];
        const f1Range = {min: 200, max: 1100};
        const f2Range = {min: 700, max: 3300};

        const runFrame = (frame: number): void => {
            // Mutate point positions slightly per frame to force gradient
            // recomputation paths (both edge endpoints differ frame-to-frame).
            for (let i = 0; i < points.length; i++) {
                const phase = frame * 0.01 + i;
                points[i].x = 180 + Math.sin(phase) * 60;
                points[i].y = 180 + Math.cos(phase) * 60;
            }
            drawVowelChrome(ctx, size, f1Range, f2Range);
            drawVowelPolygon(ctx, points, ordering, 3);
            drawVowelDots(ctx, points, points.length, 10);
        };

        // Warmup
        for (let i = 0; i < WARMUP_ITERATIONS; i++) {
            runFrame(i);
        }
        globalThis.gc();
        const baseline = perfMem.memory.usedJSHeapSize;

        // Act
        for (let i = 0; i < PAINT_ITERATIONS; i++) {
            runFrame(WARMUP_ITERATIONS + i);
        }
        globalThis.gc();
        const after = perfMem.memory.usedJSHeapSize;

        // Assert
        console.log(`vowelModule2dCanvas.alloc heap delta: ${after - baseline} bytes`);
        expect(after - baseline).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);
    });
});
