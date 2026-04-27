// Browser-mode test setup: signal React that act() is supported in
// this environment. Must run before React's module init (React reads
// the global once at first import) - Vitest's `setupFiles` config
// guarantees that ordering, which a top-level assignment in any test
// file cannot do because ESM hoists imports above module body.
declare global {
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
