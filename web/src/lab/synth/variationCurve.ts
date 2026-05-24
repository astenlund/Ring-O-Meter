// Builds a per-voice detune automation curve (in cents) from seeded slow drift
// plus fast jitter. Vibrato is NOT here (it is a live LFO node, deterministic
// from phase 0). The curve is sampled at CURVE_RATE_HZ and applied to the
// source's detune via setValueCurveAtTime, so the same seed reproduces it.

import {mulberry32} from './seededRng';

export const CURVE_RATE_HZ = 100; // 10 ms detune grid
export const DRIFT_CONTROL_HZ = 2; // slow-drift control points; interpolated between

export function buildDetuneCents(durationS: number, driftCents: number, jitterCents: number, seed: number): Float32Array {
    const rng = mulberry32(seed);
    const n = Math.max(2, Math.round(durationS * CURVE_RATE_HZ));
    const out = new Float32Array(n);

    const controlCount = Math.max(2, Math.round(durationS * DRIFT_CONTROL_HZ) + 1);
    const controls = new Float32Array(controlCount);
    for (let i = 0; i < controlCount; i++) {
        controls[i] = (rng() * 2 - 1) * driftCents;
    }

    for (let i = 0; i < n; i++) {
        const pos = (i / (n - 1)) * (controlCount - 1);
        const lo = Math.floor(pos);
        const hi = Math.min(controlCount - 1, lo + 1);
        const frac = pos - lo;
        const drift = controls[lo] + (controls[hi] - controls[lo]) * frac;
        const jitter = (rng() * 2 - 1) * jitterCents;
        out[i] = drift + jitter;
    }

    return out;
}
