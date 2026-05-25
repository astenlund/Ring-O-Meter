// Per-dimension coefficient extraction for the synthesis-lab MVP. Pure,
// read-only over the calibration store. Groups decisive A/B trials by
// sweepAxis and applies the spec's first-match-wins status precedence.

import type {CalibrationTrial} from '../store/calibrationTrial';
import type {CalibrationStore} from '../store/calibrationStore';
import {fitFirthLogistic, slopeCi95, type FitPoint} from './logisticFit';

const N_FLOOR = 20;

interface BaseCoefficient {
    status: 'insufficient-data' | 'insufficient-variation' | 'did-not-converge';
    n: number;
}

interface FittedCoefficient {
    status: 'ok' | 'saturated' | 'no-effect';
    n: number;
    slope: number;
    ci95: [number, number];
    intercept: number;
    covariance: [[number, number], [number, number]];
}

export type CoefficientResult = BaseCoefficient | FittedCoefficient;

// Derived from the union so the status set has a single source of truth: adding a
// status to either arm interface automatically extends CoefficientStatus.
export type CoefficientStatus = CoefficientResult['status'];

function fitOneAxis(points: FitPoint[]): CoefficientResult {
    const n = points.length;
    if (n < N_FLOOR) {
        return {status: 'insufficient-data', n};
    }

    const distinct = new Set(points.map((p) => p.x));
    if (distinct.size < 2) {
        return {status: 'insufficient-variation', n};
    }

    const fit = fitFirthLogistic(points);
    if (!fit.converged) {
        return {status: 'did-not-converge', n};
    }

    if (fit.separated) {
        const ci95 = slopeCi95(points);

        return {status: 'saturated', n, slope: fit.slope, ci95, intercept: fit.intercept, covariance: fit.covariance};
    }

    const ci95 = slopeCi95(points);
    const status = ci95[0] <= 0 && ci95[1] >= 0 ? 'no-effect' : 'ok';

    return {status, n, slope: fit.slope, ci95, intercept: fit.intercept, covariance: fit.covariance};
}

export function fitCoefficients(rows: CalibrationTrial[]): Map<string, CoefficientResult> {
    const byAxis = new Map<string, FitPoint[]>();
    for (const r of rows) {
        // Sanity trials (isSanityTrial) are not special-cased: a decisive A/B sweep choice
        // counts as an ordinary data point regardless of the flag. Whether to exclude them
        // is a protocol-layer question, not the fit's.
        if (r.selectorMode !== 'sweep' || r.sweepAxis === null || r.sweepDelta === null) {
            continue;
        }

        if (r.choice !== 'A' && r.choice !== 'B') {
            continue;
        }

        let points = byAxis.get(r.sweepAxis);
        if (!points) {
            points = [];
            byAxis.set(r.sweepAxis, points);
        }

        points.push({x: r.sweepDelta, y: r.choice === 'B' ? 1 : 0});
    }

    const result = new Map<string, CoefficientResult>();
    for (const [axis, points] of byAxis) {
        result.set(axis, fitOneAxis(points));
    }

    return result;
}

export async function computeCalibration(store: CalibrationStore): Promise<{coefficients: Map<string, CoefficientResult>; skippedMalformedCount: number}> {
    const {rows, skippedMalformedCount} = await store.getAllTrials();

    return {coefficients: fitCoefficients(rows), skippedMalformedCount};
}
