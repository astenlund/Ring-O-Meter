import {describe, test, expect} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {act} from 'react';
import {useFrameState} from '../session/useFrameState';
import type {AnalysisFrame} from '../wire/frames';

declare global {
    var gc: (() => void) | undefined;
}

interface PerformanceWithMemory extends Performance {
    memory?: {usedJSHeapSize: number};
}

const HEAP_DELTA_BUDGET_BYTES = 100 * 1024;
const APPLY_ITERATIONS = 10_000;
const WARMUP_ITERATIONS = 500;

function buildFrame(channelId: string, hz: number): AnalysisFrame {
    return {
        channelId,
        clientTsMs: Date.now(),
        fundamentalHz: hz,
        confidence: 0.9,
        rmsDb: -12,
        fundamentalHzRaw: hz,
    };
}

describe('frame-state allocation budget', () => {
    test(`${APPLY_ITERATIONS} applyFrame calls leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB above warmup baseline`, async () => {
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
        const capturedRef: {fn: ((frame: AnalysisFrame) => void) | null} = {fn: null};
        function Harness(): null {
            const {applyFrame} = useFrameState();
            capturedRef.fn = applyFrame;

            return null;
        }
        await act(async () => {
            root.render(<Harness />);
        });
        const apply = capturedRef.fn;
        if (!apply) {
            throw new Error('useFrameState did not expose applyFrame');
        }

        const waitForFlushes = () => new Promise<void>((resolve) => {
            setTimeout(resolve, 300);
        });

        for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
            apply(buildFrame('a', 220));
            apply(buildFrame('b', 440));
        }
        await waitForFlushes();
        globalThis.gc();
        const baseline = perfMem.memory.usedJSHeapSize;

        for (let i = 0; i < APPLY_ITERATIONS; i += 1) {
            apply(buildFrame('a', 220));
            apply(buildFrame('b', 440));
        }
        await waitForFlushes();
        globalThis.gc();
        const after = perfMem.memory.usedJSHeapSize;

        expect(after - baseline).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);

        await act(async () => {
            root.unmount();
        });
    });
});
