// Pure generation helpers for the calibration protocol: config validation, the
// two RNG-driven randomizations, and the seed draw. The stateful session
// (calibrationSession.ts) composes these over one mulberry32 stream.

import type {Rng} from '../synth/seededRng';
import {applyAxisDelta} from './axisTransform';
import {formantCollides} from './coincidence';
import {ALL_SWEEP_AXES, CalibrationConfigError, type SessionConfig, type SweepAxis} from './protocolTypes';

export const MAX_RESAMPLE_ATTEMPTS = 50;

export function axisIsTuning(axis: SweepAxis): boolean {
    return axis === 'fundamental';
}

function isFiniteNumber(n: unknown): n is number {
    return typeof n === 'number' && Number.isFinite(n);
}

export function validateConfig(config: SessionConfig): void {
    const sel = config.selector;
    if (!ALL_SWEEP_AXES.includes(sel.axis)) {
        throw new CalibrationConfigError(`Unknown sweep axis: ${String(sel.axis)}.`);
    }

    const voiceCount = sel.baseline.voices.length;
    if (!Number.isInteger(sel.targetVoiceIndex) || sel.targetVoiceIndex < 0 || sel.targetVoiceIndex >= voiceCount) {
        throw new CalibrationConfigError(`targetVoiceIndex ${sel.targetVoiceIndex} out of range [0, ${voiceCount}).`);
    }

    if (sel.mode === 'sweep') {
        if (sel.deltas.length === 0) {
            throw new CalibrationConfigError('Sweep deltas must be non-empty.');
        }

        const seen = new Set<number>();
        for (const d of sel.deltas) {
            if (!isFiniteNumber(d) || d === 0) {
                throw new CalibrationConfigError('Sweep deltas must be non-zero and finite.');
            }

            if (seen.has(d)) {
                throw new CalibrationConfigError(`Duplicate sweep delta: ${d}.`);
            }

            seen.add(d);
        }

        if (!Number.isInteger(sel.repeats) || sel.repeats < 1) {
            throw new CalibrationConfigError(`repeats must be an integer >= 1, got ${sel.repeats}.`);
        }

        // Up-front confound check: the deterministic sweep range is fully known.
        if (axisIsTuning(sel.axis)) {
            for (const d of sel.deltas) {
                const variant = applyAxisDelta(sel.baseline, sel.axis, sel.targetVoiceIndex, d);
                if (formantCollides(sel.baseline) || formantCollides(variant)) {
                    throw new CalibrationConfigError(`Sweep step delta=${d} lands a control formant on a coincidence.`);
                }
            }
        }
    } else {
        if (!isFiniteNumber(sel.range.min) || !isFiniteNumber(sel.range.max) || sel.range.min >= sel.range.max) {
            throw new CalibrationConfigError('Random range requires finite min < max.');
        }
    }
}

// Assigns which physical variant is chordA vs chordB, sign-balancing sweepDelta
// (= paramB - paramA). variant0 is the baseline-side value (delta 0), variant1 is
// shifted by +delta along the axis.
export function assignLabels<T>(rng: Rng, variant0: T, variant1: T, delta: number): {chordA: T; chordB: T; sweepDelta: number} {
    if (rng() < 0.5) {
        return {chordA: variant0, chordB: variant1, sweepDelta: delta};
    }

    return {chordA: variant1, chordB: variant0, sweepDelta: -delta};
}

export function choosePresentationOrder(rng: Rng): ['A', 'B'] | ['B', 'A'] {
    return rng() < 0.5 ? ['A', 'B'] : ['B', 'A'];
}

export function drawSeed(rng: Rng): number {
    return Math.floor(rng() * 2 ** 32) >>> 0;
}
