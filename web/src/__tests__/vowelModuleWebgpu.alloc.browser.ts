import {describe, expect, test} from 'vitest';
import {VowelModuleWebgpu} from '../plot/vowelModuleWebgpu';
import {createFrameRing, FrameRingWriter, FrameRingReader} from '../audio/frameRing';
import type {VoiceEntry} from '../plot/plotMessages';

interface PerformanceWithMemory extends Performance {
    memory?: {usedJSHeapSize: number};
}

// PLACEHOLDER until orchestrator runs the mid-task review + 3-run
// Calibrated 2026-05-04: 3 consecutive runs after applying mid-task
// review fix-nows (polarAngleSortInto promotion + MAX_VOICES dedupe +
// F1/F2 axis-bound heuristic tags) measured 11640 / 11496 / 11376
// bytes. Max * 1.5 = 17460 bytes; rounded up to 20 KB for clean
// headroom against V8 GC jitter and WebGPU command-encoder churn in
// the test harness. Most of the residual delta is harness overhead
// (createCommandEncoder + getCurrentTexture().createView() are not
// fully zero-alloc on V8); the module's own update()+draw() path is
// effectively zero-alloc per the pre-allocated scratch + shared
// polarAngleSortInto pattern. Per the hot-path-allocation-discipline
// pattern; tighten if a future review run reproducibly measures a
// lower baseline.
const HEAP_DELTA_BUDGET_BYTES = 20 * 1024;
const PAINT_ITERATIONS = 1_000;
const WARMUP_ITERATIONS = 200;

describe('Vowel module WebGPU paint allocation budget', () => {
    test(`${PAINT_ITERATIONS} paints leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB`, async () => {
        // Arrange
        const perfMem = performance as PerformanceWithMemory;
        if (!globalThis.gc || !perfMem.memory) {
            throw new Error('Test requires Chromium launched with --js-flags="--expose-gc"');
        }
        if (!navigator.gpu) {
            throw new Error('Test requires Chromium launched with --enable-unsafe-webgpu');
        }

        const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
        if (!adapter) {
            throw new Error('No WebGPU adapter available');
        }
        const device = await adapter.requestDevice();

        const canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 360;
        document.body.appendChild(canvas);
        const offscreen = canvas.transferControlToOffscreen();
        const context = offscreen.getContext('webgpu') as GPUCanvasContext;
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({device, format, alphaMode: 'premultiplied'});

        const module = new VowelModuleWebgpu();
        module.init(device, device.queue);
        module.setBacking(360, 360, 1);

        // 4-voice fanout fixture matching the dom7 chord shape used by
        // the e2e arms.
        const voices: ReadonlyArray<VoiceEntry> = [
            {channelId: 'a', label: 'V1', color: '#5cf'},
            {channelId: 'b', label: 'V2', color: '#fc5'},
            {channelId: 'c', label: 'V3', color: '#5f9'},
            {channelId: 'd', label: 'V4', color: '#f5c'},
        ];

        const writers: FrameRingWriter[] = [];
        for (const voice of voices) {
            const sab = createFrameRing();
            writers.push(new FrameRingWriter(sab));
            const reader = new FrameRingReader(sab, 0);
            module.attachVoice(voice.channelId, voice.color, reader);
        }
        module.setRoster(voices);

        // Fixture: 4 voices spread around the F1/F2 plane at distinct
        // positions so the polygon has area and the dots are at distinct
        // points. Vary slightly per frame to exercise update().
        const baseFormants = [
            {f1: 400, f2: 1200},
            {f1: 600, f2: 1600},
            {f1: 800, f2: 2000},
            {f1: 500, f2: 2400},
        ];

        const publish = (frame: number): void => {
            const ts = performance.now() + frame * 21;
            for (let i = 0; i < voices.length; i++) {
                const base = baseFormants[i];
                const jitter = Math.sin(frame * 0.01 + i) * 5;
                writers[i].publish({
                    captureContextMs: ts,
                    fundamentalHz: 220,
                    confidence: 0.9,
                    rmsDb: -25,
                    fundamentalHzRaw: 220,
                    f1Hz: base.f1 + jitter,
                    f2Hz: base.f2 + jitter,
                    f3Hz: 2500,
                    f4Hz: 3500,
                });
            }
        };

        // Simulate the host frame loop: update + encoder + render pass + submit.
        const runFrame = (frame: number): void => {
            publish(frame);
            module.update(16.7);
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: context.getCurrentTexture().createView(),
                    clearValue: {r: 0, g: 0, b: 0, a: 0},
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
            });
            module.draw(pass);
            pass.end();
            device.queue.submit([encoder.finish()]);
        };

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
        console.log(`vowelModuleWebgpu.alloc heap delta: ${after - baseline} bytes`);
        expect(after - baseline).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);

        module.dispose();
    });
});
