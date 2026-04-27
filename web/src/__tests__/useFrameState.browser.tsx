import {describe, test, expect} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {act} from 'react';
import {useFrameState, type FrameStateControl} from '../audio/useFrameState';
import {createFrameRing, FrameRingReader, FrameRingWriter} from '../audio/frameRing';

interface ProbeRef {
    control: FrameStateControl | null;
    renderCount: number;
}

const FLUSH_WAIT_MS = 300;

const waitForFlush = (): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, FLUSH_WAIT_MS);
});

describe('useFrameState structural invariants', () => {
    test('buffer-flip produces a distinct latest reference each flush', async () => {
        const probeRef: ProbeRef = {control: null, renderCount: 0};
        function Harness(): null {
            probeRef.control = useFrameState();
            probeRef.renderCount += 1;

            return null;
        }

        const container = document.createElement('div');
        document.body.appendChild(container);
        // Bare createRoot with no <StrictMode> wrapper - StrictMode
        // would double-invoke the render body and the count-delta
        // assertion below would still pass (delta becomes 4) but
        // would no longer prove "two distinct commits happened."
        const root: Root = createRoot(container);
        await act(async () => {
            root.render(<Harness />);
        });

        const control = probeRef.control;
        if (!control) {
            throw new Error('useFrameState did not expose control');
        }

        const sab = createFrameRing();
        const writer = new FrameRingWriter(sab);
        const reader = new FrameRingReader(sab, 0);
        control.registerReader('a', reader);

        // Capture the initial state BEFORE any publish-driven render,
        // so each subsequent publish-flush cycle contributes exactly
        // one render to the delta.
        const latest0 = probeRef.control!.latest;
        const count0 = probeRef.renderCount;

        // Wrap publish + flush wait in act() so React is aware of
        // the rAF-driven setLatest that fires during the wait. Without
        // act(), each setLatest emits an "update inside a test was
        // not wrapped in act(...)" console.error - cosmetic, but the
        // alloc test inherits the same noise; explicit act() here
        // keeps the structural test's output clean.
        await act(async () => {
            writer.publish({captureContextMs: 21, fundamentalHz: 220, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 220});
            await waitForFlush();
        });
        const latest1 = probeRef.control!.latest;
        const count1 = probeRef.renderCount;

        await act(async () => {
            writer.publish({captureContextMs: 42, fundamentalHz: 330, confidence: 0.85, rmsDb: -30, fundamentalHzRaw: 330});
            await waitForFlush();
        });
        const latest2 = probeRef.control!.latest;
        const count2 = probeRef.renderCount;

        // Each publish-flush cycle must produce at least one new
        // commit. Without this, a same-reference regression would
        // bail out of React's `Object.is` equality check (no render),
        // and the !== assertions below cannot distinguish that
        // failure mode from a working flip on its own.
        expect(count1).toBeGreaterThan(count0);
        expect(count2).toBeGreaterThan(count1);
        // The actual buffer-flip invariant: each commit hands React
        // a different reference. Two flips in sequence prove the
        // pool actually rotates rather than transitioning once.
        expect(latest1).not.toBe(latest0);
        expect(latest2).not.toBe(latest1);

        control.unregisterReader('a');
        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    test('unregisterReader preserves survivor latest values', async () => {
        const probeRef: ProbeRef = {control: null, renderCount: 0};
        function Harness(): null {
            probeRef.control = useFrameState();
            probeRef.renderCount += 1;

            return null;
        }

        const container = document.createElement('div');
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        await act(async () => {
            root.render(<Harness />);
        });

        const control = probeRef.control;
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

        await act(async () => {
            writerA.publish({captureContextMs: 21, fundamentalHz: 220, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 220});
            writerB.publish({captureContextMs: 21, fundamentalHz: 440, confidence: 0.95, rmsDb: -30, fundamentalHzRaw: 440});
            await waitForFlush();
        });

        // Capture survivor's values just before the unregister.
        const survivorBefore = {
            fundamentalHz: probeRef.control!.latest.b.fundamentalHz,
            confidence: probeRef.control!.latest.b.confidence,
        };

        // Synchronously unregister 'a' and observe React commit.
        await act(async () => {
            control.unregisterReader('a');
        });

        const survivorAfter = probeRef.control!.latest.b;
        // Without the copy-active-into-new-active step in
        // unregisterReader, the survivor would roll back ~66 ms (one
        // flush worth of staleness). The values must match exactly.
        expect(survivorAfter.fundamentalHz).toBe(survivorBefore.fundamentalHz);
        expect(survivorAfter.confidence).toBe(survivorBefore.confidence);
        // The dropped key must actually be gone.
        expect(probeRef.control!.latest.a).toBeUndefined();

        control.unregisterReader('b');
        await act(async () => {
            root.unmount();
        });
        container.remove();
    });
});
