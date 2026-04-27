import {describe, test, expect} from 'vitest';
import {
    FrameRingReader,
    FrameRingWriter,
    type PublishFrame,
    createFrameRing,
} from '../audio/frameRing';

declare global {
    var gc: (() => void) | undefined;
}

interface PerformanceWithMemory extends Performance {
    memory?: {usedJSHeapSize: number};
}

const PUBLISH_ITERATIONS = 10_000;
const READ_ITERATIONS = 10_000;
const WARMUP_ITERATIONS = 500;
const WRITER_BUDGET_BYTES = 12 * 1024;
const READER_BUDGET_BYTES = 4 * 1024;

describe('frameRing writer allocation budget', () => {
    test(`${PUBLISH_ITERATIONS} publishes leave heap under ${WRITER_BUDGET_BYTES / 1024} KB above warmup baseline`, () => {
        const perfMem = performance as PerformanceWithMemory;
        if (!globalThis.gc || !perfMem.memory) {
            throw new Error('Test requires Chromium launched with --js-flags="--expose-gc" and --enable-precise-memory-info');
        }

        const sab = createFrameRing();
        const writer = new FrameRingWriter(sab);
        let t = 0;
        // Scratch hoisted out of the publish closure so the budget
        // measures the writer's per-call cost (atomic store + five
        // typed-array writes), not a per-call object literal.
        const scratch: PublishFrame = {captureContextMs: 0, fundamentalHz: 0, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 0};
        const publish = () => {
            t += 21;
            const hz = 220 + (t & 0xff) * 0.01;
            scratch.captureContextMs = t;
            scratch.fundamentalHz = hz;
            scratch.fundamentalHzRaw = hz;
            writer.publish(scratch);
        };

        for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
            publish();
        }
        globalThis.gc();
        const baseline = perfMem.memory.usedJSHeapSize;

        for (let i = 0; i < PUBLISH_ITERATIONS; i += 1) {
            publish();
        }
        globalThis.gc();
        const after = perfMem.memory.usedJSHeapSize;

        expect(after - baseline).toBeLessThan(WRITER_BUDGET_BYTES);
    });
});

describe('frameRing reader.forEach allocation budget', () => {
    test(`${READ_ITERATIONS} forEach calls leave heap under ${READER_BUDGET_BYTES / 1024} KB above warmup baseline`, () => {
        const perfMem = performance as PerformanceWithMemory;
        if (!globalThis.gc || !perfMem.memory) {
            throw new Error('Test requires Chromium launched with --js-flags="--expose-gc" and --enable-precise-memory-info');
        }

        const sab = createFrameRing();
        const writer = new FrameRingWriter(sab);
        const reader = new FrameRingReader(sab, 0);
        // Populate the ring to ~plot-window fullness. Setup loop runs
        // before the warmup baseline gc(), so per-iteration object
        // literals here don't contribute to the budget that measures
        // readAll() below; readability beats scratch hoisting (matches
        // the convention in paintLoop.alloc.browser.ts).
        const baseMs = 0;
        for (let i = 0; i < 470; i += 1) {
            const hz = 220 + Math.sin(i * 0.1) * 10;
            writer.publish({captureContextMs: baseMs + i * 21, fundamentalHz: hz, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: hz});
        }

        const readAll = () => {
            reader.forEach(0, (_tsMs, _hz, _conf) => {
                // Touch arguments so the JIT can't optimise them away;
                // no allocation in the body.
                if (_tsMs < 0) {
                    throw new Error('unreachable');
                }
            });
        };

        for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
            readAll();
        }
        globalThis.gc();
        const baseline = perfMem.memory.usedJSHeapSize;

        for (let i = 0; i < READ_ITERATIONS; i += 1) {
            readAll();
        }
        globalThis.gc();
        const after = perfMem.memory.usedJSHeapSize;

        expect(after - baseline).toBeLessThan(READER_BUDGET_BYTES);
    });
});
