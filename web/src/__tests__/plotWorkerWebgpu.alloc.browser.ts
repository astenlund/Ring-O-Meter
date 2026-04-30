import {describe, expect, test} from 'vitest';
import {WebgpuPlotRenderer} from '../plot/webgpuPlotRenderer';
import {createFrameRing, FrameRingWriter, type FrameSource} from '../audio/frameRing';
import type {VoiceEntry} from '../plot/plotMessages';

declare global {
    var gc: (() => void) | undefined;
}

interface PerformanceWithMemory extends Performance {
    memory?: {usedJSHeapSize: number};
}

// TODO: tighten this after three green CI runs to measured * 1.5
// per the hot-path-allocation-discipline pattern. Initial ceiling
// is generous: WebGPU device init + first paint pay one-time costs
// (pipeline compile residue, command-encoder warmup) that the warmup
// loop should absorb but may not fully eliminate.
const HEAP_DELTA_BUDGET_BYTES = 100 * 1024;
const PAINT_ITERATIONS = 1_000;
const WARMUP_ITERATIONS = 200;

describe('WebGPU plot paint allocation budget', () => {
    test(`${PAINT_ITERATIONS} paints leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB`, async () => {
        const perfMem = performance as PerformanceWithMemory;
        if (!globalThis.gc || !perfMem.memory) {
            throw new Error('Test requires Chromium launched with --js-flags="--expose-gc"');
        }
        if (!navigator.gpu) {
            throw new Error('Test requires Chromium launched with --enable-unsafe-webgpu');
        }

        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 360;
        document.body.appendChild(canvas);
        // OffscreenCanvas-equivalent: WebgpuPlotRenderer.init expects an
        // OffscreenCanvas; the page-realm equivalent is
        // canvas.transferControlToOffscreen().
        const offscreen = canvas.transferControlToOffscreen();

        const renderer = new WebgpuPlotRenderer();
        await renderer.init(offscreen);
        renderer.setBacking(800, 360, 1);
        renderer.setWindow(10_000, 80, 600);
        renderer.setEpochOffset(0);

        const voices: ReadonlyArray<VoiceEntry> = [
            {channelId: 'a', label: 'Voice 1', color: '#5cf'},
        ];
        renderer.setRoster(voices);
        const sab = createFrameRing();
        const writer = new FrameRingWriter(sab);
        const source: FrameSource = {sab, epochOffsetMs: 0};
        renderer.attachChannel('a', source);

        // Pre-fill the ring with ~470 in-window samples (10 s window
        // at the worklet's ~47 Hz publish rate).
        const baseMs = performance.now();
        for (let i = 0; i < 470; i += 1) {
            const ts = baseMs + i * 21;
            const hz = 220 + Math.sin(i * 0.1) * 10;
            writer.publish({
                captureContextMs: ts,
                fundamentalHz: hz,
                confidence: 0.9,
                rmsDb: -30,
                fundamentalHzRaw: hz,
            });
        }

        for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
            renderer.paint();
        }
        globalThis.gc();
        const baseline = perfMem.memory.usedJSHeapSize;

        for (let i = 0; i < PAINT_ITERATIONS; i += 1) {
            renderer.paint();
        }
        globalThis.gc();
        const after = perfMem.memory.usedJSHeapSize;

        expect(after - baseline).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);

        renderer.dispose();
    });
});
