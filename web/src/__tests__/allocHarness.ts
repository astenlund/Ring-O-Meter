import {FrameRingWriter} from '../audio/frameRing';

const PRECONDITION_MESSAGE =
    'Alloc test requires Chromium launched with --js-flags="--expose-gc" and --enable-precise-memory-info';

export interface AllocHeap {
    readonly gc: () => void;
    readonly memory: {usedJSHeapSize: number};
}

// Throws if the alloc-test launch flags are not engaged. Returns
// non-optional handles so the caller can read heap delta without
// re-narrowing on every measurement. test-globals.d.ts types the
// underlying globals as optional precisely so this guard keeps its
// narrowing power.
export function requireAllocHeap(): AllocHeap {
    const gc = globalThis.gc;
    const memory = performance.memory;
    if (!gc || !memory) {
        throw new Error(PRECONDITION_MESSAGE);
    }

    return {gc, memory};
}

// Two-call gc() settle. The second call sees the first call's
// followups (slack-tracked young-gen, weak references) and produces
// a reliably tight baseline. A single gc() leaves stragglers on the
// wrong side of the measurement boundary in ~1-in-6 runs, producing
// 4-7x heap-delta spikes. A microtask flush between the calls makes
// no measurable difference.
export function settleHeap(heap: AllocHeap): void {
    heap.gc();
    heap.gc();
}

// Convenience for callers that only care about the UI fields of a
// PublishFrame (timestamp, fundamental, confidence). Fills in the
// placeholder rmsDb / fundamentalHzRaw / formant slots so that
// noise stays out of the call site. Allocates a fresh literal per
// call: appropriate for setup / warmup loops and structural tests,
// not for measured zero-alloc loops (those should hoist a scratch
// PublishFrame and call writer.publish directly).
export function publishUiOnly(
    writer: FrameRingWriter,
    captureContextMs: number,
    fundamentalHz: number,
    confidence: number,
): void {
    writer.publish({
        captureContextMs,
        fundamentalHz,
        confidence,
        rmsDb: -30,
        fundamentalHzRaw: fundamentalHz,
        f1Hz: 0,
        f2Hz: 0,
        f3Hz: 0,
        f4Hz: 0,
    });
}
