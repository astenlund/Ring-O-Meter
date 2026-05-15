import {describe, expect, test} from 'vitest';
import {TraceModule} from '../plot/traceModule';
import {createFrameRing, FrameRingWriter, type FrameSource} from '../audio/frameRing';
import type {VoiceEntry} from '../plot/plotMessages';
import {publishUiOnly, requireAllocHeap, settleHeap} from './allocHarness';

// Calibrated 2026-05-16: 3 consecutive local runs measured 0 / 0 / 0
// bytes (performance.memory resolution is 1 KB; 0 means delta < 1 KB).
// Max * 1.5 = 0; floor set to 4 KB — smallest meaningful regression
// net given GC granularity. One-time pipeline compile residue and
// command-encoder warmup costs are fully absorbed by the 200-iteration
// warmup loop. Per the hot-path-allocation-discipline pattern; tighten
// further only if a future run reproducibly measures below 4 KB.
const HEAP_DELTA_BUDGET_BYTES = 4 * 1024;
const PAINT_ITERATIONS = 1_000;
const WARMUP_ITERATIONS = 200;

describe('WebGPU plot paint allocation budget', () => {
    test(`${PAINT_ITERATIONS} paints leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB`, async () => {
        // Arrange
        const heap = requireAllocHeap();
        if (!navigator.gpu) {
            throw new Error('Test requires Chromium launched with --enable-unsafe-webgpu');
        }

        const canvas = document.createElement('canvas');
        canvas.width = 800;
        canvas.height = 360;
        document.body.appendChild(canvas);
        // OffscreenCanvas-equivalent: TraceModule.init expects an
        // OffscreenCanvas; the page-realm equivalent is
        // canvas.transferControlToOffscreen().
        const offscreen = canvas.transferControlToOffscreen();

        const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
        if (!adapter) {
            throw new Error('Test requires a WebGPU adapter');
        }
        const device = await adapter.requestDevice();
        const format = navigator.gpu.getPreferredCanvasFormat();

        const renderer = new TraceModule();
        await renderer.init(offscreen, device, format);
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
        // at the worklet's ~47 Hz publish rate). TraceModule renders
        // pitch only; formants are not read on this path so the
        // publishUiOnly placeholders are inert here.
        const baseMs = performance.now();
        for (let i = 0; i < 470; i += 1) {
            const ts = baseMs + i * 21;
            const hz = 220 + Math.sin(i * 0.1) * 10;
            publishUiOnly(writer, ts, hz, 0.9);
        }

        // Simulate the host frame loop: update (CPU + writeBuffer) then
        // encoder + render pass + submit (mirroring plotWorkerWebgpu.ts).
        const runFrame = (): void => {
            renderer.update(0);
            const context = renderer.gpuContext!;
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: context.getCurrentTexture().createView(),
                    clearValue: {r: 0, g: 0, b: 0, a: 0},
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });
            renderer.draw(pass);
            pass.end();
            device.queue.submit([encoder.finish()]);
        };

        for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
            runFrame();
        }
        settleHeap(heap);
        const baseline = heap.memory.usedJSHeapSize;

        // Act
        for (let i = 0; i < PAINT_ITERATIONS; i += 1) {
            runFrame();
        }
        settleHeap(heap);
        const after = heap.memory.usedJSHeapSize;

        // Assert
        console.log(`plotWorkerWebgpu.alloc heap delta: ${after - baseline} bytes`);
        expect(after - baseline).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);

        renderer.dispose();
    });
});
