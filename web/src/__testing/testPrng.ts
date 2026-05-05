// Deterministic LCG PRNG used across DSP tests where reproducibility
// matters more than statistical quality. Same constants as glibc's
// `rand()` (1103515245, 12345); the high bit is masked off to keep the
// value non-negative, then mapped to [-1, 1]. Suitable for synthesizing
// white-noise excitation for AR(2)-style speech models in
// formantDetector.test.ts and lpc.test.ts; do NOT use for cryptographic
// or distribution-sensitive tests.

export function makeLcgRand(seed = 42): () => number {
    let state = seed;

    return (): number => {
        state = (state * 1103515245 + 12345) >>> 0;

        return ((state & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    };
}
