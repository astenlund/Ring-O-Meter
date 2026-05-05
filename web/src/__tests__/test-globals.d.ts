// Ambient declarations for test-only globals exposed via Chromium
// launch flags. Keeps the alloc tests well-typed without pulling
// @types/node into the app's `types` array, which would mask
// accidental use of Node-only APIs (process, Buffer, __dirname) in
// browser/worklet code.
//
// `gc` comes from Chromium's `--js-flags="--expose-gc"` and is
// referenced exclusively by tests under web/src/__tests__/*.alloc.*.
// `Performance.memory` comes from `--enable-precise-memory-info`.
//
// Both are typed as optional so the alloc tests' precondition checks
// (`if (!globalThis.gc || !perfMem.memory) throw ...`) keep their
// narrowing power instead of being flagged as always-true.

declare global {
    var gc: (() => void) | undefined;

    interface Performance {
        memory?: {usedJSHeapSize: number};
    }
}

export {};
