// Ambient declarations for test-only globals exposed via Chromium
// launch flags. Keeps the alloc tests well-typed without pulling
// @types/node into the app's `types` array, which would mask
// accidental use of Node-only APIs (process, Buffer, __dirname) in
// browser/worklet code.
//
// `gc` comes from Chromium's `--js-flags="--expose-gc"`.
// `Performance.memory` comes from `--enable-precise-memory-info`.
// Both are read by `allocHarness.requireAllocHeap()`, which alloc
// tests under web/src/__tests__/*.alloc.* call to obtain non-optional
// handles for measurement.
//
// Both are typed as optional so the harness's precondition narrowing
// (`if (!gc || !memory) throw ...`) is not flagged as always-true.

declare global {
    var gc: (() => void) | undefined;

    interface Performance {
        memory?: {usedJSHeapSize: number};
    }
}

export {};
