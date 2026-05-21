import {describe, expect, test} from 'vitest';
import {init, update, draw, dispose} from '../plot/chordBarsModule';
import type {ChordBarsInput} from '../plot/chordBarsModule';
import {requireAllocHeap, settleHeap} from './allocHarness';

// Calibrated: 2D canvas API per-frame allocations (arc, fillText path
// objects) live in Chromium's renderer-process C++ heap, not the JS
// heap measured by performance.memory.usedJSHeapSize. The JS-heap delta
// on a zero-alloc paint loop approaches zero; 60 KB provides headroom
// above the 1 KB quantization floor per the project's alloc-test floor
// convention while still catching real regressions (per-frame JSON.stringify,
// array spreads, etc.).
const HEAP_DELTA_BUDGET_BYTES = 60 * 1024;
const DRAW_ITERATIONS = 100;
const WARMUP_ITERATIONS = 50;

describe('chordBarsModule 2D canvas allocation budget', () => {
    test(`${DRAW_ITERATIONS} draws leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB`, async () => {
        // Arrange
        const heap = requireAllocHeap();

        const canvas = new OffscreenCanvas(320, 200);
        init(canvas, {width: 320, height: 200}, 1);

        // 4-voice synthetic input. channelIdToSlot maps 4 channel IDs
        // to slot indices 0-3. residualsBySlot carries values within
        // ±50¢ (no off-scale on most frames) and one off-scale value to
        // exercise the wedge path.
        const residuals = new Float32Array(4);
        const channelIdToSlot: ReadonlyMap<string, number> = new Map([
            ['ch-0', 0],
            ['ch-1', 1],
            ['ch-2', 2],
            ['ch-3', 3],
        ]);

        const buildInput = (frame: number): ChordBarsInput => {
            // Vary residuals per frame so the draw path exercises different
            // dot positions without allocating new objects.
            residuals[0] = Math.sin(frame * 0.1) * 10;      // within ±10¢
            residuals[1] = Math.cos(frame * 0.13) * 20;     // within ±20¢
            residuals[2] = frame % 20 === 0 ? 60 : 3;       // off-scale every 20 frames
            residuals[3] = -Math.sin(frame * 0.07) * 15;    // within ±15¢

            return {
                lockedChordType: 1,
                residualsBySlot: residuals,
                rootChannelId: 'ch-0',
                channelIdToSlot,
            };
        };

        // Warmup: prime V8 JIT and Chromium's canvas path cache.
        for (let i = 0; i < WARMUP_ITERATIONS; i++) {
            update(buildInput(i));
            draw();
        }
        settleHeap(heap);
        const baseline = heap.memory.usedJSHeapSize;

        // Act
        for (let i = 0; i < DRAW_ITERATIONS; i++) {
            update(buildInput(WARMUP_ITERATIONS + i));
            draw();
        }
        settleHeap(heap);
        const after = heap.memory.usedJSHeapSize;

        // Assert
        const delta = after - baseline;
        console.log(`chordBarsModule2dCanvas.alloc heap delta: ${delta} bytes`);
        expect(delta).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);

        // Cleanup
        dispose();
    });
});
