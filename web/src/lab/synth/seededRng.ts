// Deterministic PRNG (mulberry32) so a stored (params, seed) pair re-renders
// bit-identically. Synthesis variance (drift, jitter) draws from this; vibrato
// is a deterministic LFO and needs no RNG.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
    let a = seed >>> 0;
    return function (): number {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
