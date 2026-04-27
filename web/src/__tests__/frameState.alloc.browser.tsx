import {describe, test, expect} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {act} from 'react';
import {useFrameState, type FrameStateControl} from '../audio/useFrameState';
import {createFrameRing, FrameRingReader, FrameRingWriter, type PublishFrame} from '../audio/frameRing';

declare global {
    var gc: (() => void) | undefined;
}

interface PerformanceWithMemory extends Performance {
    memory?: {usedJSHeapSize: number};
}

const HEAP_DELTA_BUDGET_BYTES = 100 * 1024;
const POLL_ITERATIONS = 10_000;
const WARMUP_ITERATIONS = 500;

describe('frame-state allocation budget', () => {
    test(`${POLL_ITERATIONS} reader advances leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB above warmup baseline`, async () => {
        const perfMem = performance as PerformanceWithMemory;
        if (!globalThis.gc || !perfMem.memory) {
            throw new Error('Test requires Chromium launched with --js-flags="--expose-gc"');
        }

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        // Ref-object rather than a bare `let` so the post-render read
        // gets its own local narrow; a closure-captured `let` collapses
        // to `never` under verbatimModuleSyntax narrowing.
        const controlRef: {control: FrameStateControl | null} = {control: null};
        function Harness(): null {
            controlRef.control = useFrameState();

            return null;
        }
        await act(async () => {
            root.render(<Harness />);
        });
        const control = controlRef.control;
        if (!control) {
            throw new Error('useFrameState did not expose control');
        }

        const sabA = createFrameRing();
        const sabB = createFrameRing();
        const writerA = new FrameRingWriter(sabA);
        const writerB = new FrameRingWriter(sabB);
        const readerA = new FrameRingReader(sabA, 0);
        const readerB = new FrameRingReader(sabB, 0);
        control.registerReader('a', readerA);
        control.registerReader('b', readerB);

        const waitForFlush = () => new Promise<void>((resolve) => {
            setTimeout(resolve, 300);
        });

        // One scratch per writer; mutated in place each advance() so
        // the publish path stays zero-alloc against this hook's heap
        // budget rather than burning two object literals per tick.
        const scratchA: PublishFrame = {captureContextMs: 0, fundamentalHz: 0, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 0};
        const scratchB: PublishFrame = {captureContextMs: 0, fundamentalHz: 0, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 0};
        const advance = (idx: number) => {
            const hzA = 220 + (idx & 0xff) * 0.01;
            const hzB = 440 + (idx & 0xff) * 0.01;
            const ts = idx * 21;
            scratchA.captureContextMs = ts;
            scratchA.fundamentalHz = hzA;
            scratchA.fundamentalHzRaw = hzA;
            writerA.publish(scratchA);
            scratchB.captureContextMs = ts;
            scratchB.fundamentalHz = hzB;
            scratchB.fundamentalHzRaw = hzB;
            writerB.publish(scratchB);
        };

        for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
            advance(i);
        }
        await waitForFlush();
        globalThis.gc();
        const baseline = perfMem.memory.usedJSHeapSize;

        for (let i = 0; i < POLL_ITERATIONS; i += 1) {
            advance(WARMUP_ITERATIONS + i);
        }
        await waitForFlush();
        globalThis.gc();
        const after = perfMem.memory.usedJSHeapSize;

        expect(after - baseline).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);

        control.unregisterReader('a');
        control.unregisterReader('b');
        await act(async () => {
            root.unmount();
        });
    });
});
