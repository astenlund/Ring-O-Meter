import {describe, expect, test} from 'vitest';
import {ChordBarsModuleWebgpu} from '../plot/chordBarsModuleWebgpu';
import {requireAllocHeap, settleHeap} from './allocHarness';

// Calibrated on first green run; initial budget 60 KB (per plan).
// Re-tighten to max * 1.5 (floor 4 KB) once three consecutive green
// runs have been observed; see hot-path-allocation-discipline.md.
const HEAP_DELTA_BUDGET_BYTES = 60 * 1024;
const DRAW_ITERATIONS = 100;
const WARMUP_ITERATIONS = 200;

describe('ChordBarsModuleWebgpu paint allocation budget', () => {
    test(`${DRAW_ITERATIONS} draws leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB`, async () => {
        // Arrange
        const heap = requireAllocHeap();
        if (!navigator.gpu) {
            throw new Error('Test requires Chromium launched with --enable-unsafe-webgpu');
        }

        const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
        if (!adapter) {
            throw new Error('No WebGPU adapter available');
        }
        const device = await adapter.requestDevice();

        const canvas = document.createElement('canvas');
        canvas.width = 300;
        canvas.height = 320;
        document.body.appendChild(canvas);
        const offscreen = canvas.transferControlToOffscreen();

        const module = new ChordBarsModuleWebgpu();
        module.init(offscreen, device);
        module.setBacking(300, 320, 1);

        // Register slot colors matching the dom7 test fixture.
        module.setSlotColor(0, '#5cf');
        module.setSlotColor(1, '#fc5');
        module.setSlotColor(2, '#5f9');
        module.setSlotColor(3, '#f5c');

        // Pre-allocated input buffers; reused across frames so the
        // measured window sees zero allocation from the caller side.
        const residualsBySlot = new Float32Array(8);
        const channelIdToSlot = new Map<string, number>([
            ['bass', 0],
            ['bari', 1],
            ['lead', 2],
            ['tnr',  3],
        ]);

        // Sine-wave residuals to exercise the branch that renders dots.
        const buildResiduals = (frame: number): void => {
            residualsBySlot[0] = Math.sin(frame * 0.07) * 3;
            residualsBySlot[1] = Math.sin(frame * 0.11 + 1) * 8;
            residualsBySlot[2] = 0;
            residualsBySlot[3] = Math.sin(frame * 0.05 + 2) * 12;
            // Slots 4-7 unused (NaN = absent).
            for (let i = 4; i < 8; i++) {
                residualsBySlot[i] = NaN;
            }
        };

        const runFrame = (frame: number): void => {
            buildResiduals(frame);
            module.update({
                lockedChordType: 1, // DominantSeventh
                residualsBySlot,
                rootChannelId: 'bass',
                channelIdToSlot,
            });
            const encoder = device.createCommandEncoder();
            module.draw(encoder);
            device.queue.submit([encoder.finish()]);
        };

        for (let i = 0; i < WARMUP_ITERATIONS; i++) {
            runFrame(i);
        }
        settleHeap(heap);
        const baseline = heap.memory.usedJSHeapSize;

        // Act
        for (let i = 0; i < DRAW_ITERATIONS; i++) {
            runFrame(WARMUP_ITERATIONS + i);
        }
        settleHeap(heap);
        const after = heap.memory.usedJSHeapSize;

        // Assert
        console.log(`chordBarsModuleWebgpu.alloc heap delta: ${after - baseline} bytes`);
        expect(after - baseline).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);

        module.dispose();
    });
});
