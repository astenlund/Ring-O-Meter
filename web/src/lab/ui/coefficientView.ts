// Pure view helpers for the coefficient dashboard: status->bucket grouping over all
// twelve axes, and the fitted-sigmoid sparkline + CI-relative-to-zero bar geometry.
// Read-only over computeCalibration output; holds no state.

import {ALL_SWEEP_AXES, type SweepAxis} from '../protocol/protocolTypes';
import type {CoefficientResult, CoefficientStatus} from '../fit/coefficients';
import {sigmoid} from '../fit/logisticFit';

export type Bucket = 'fitted' | 'needs-attention' | 'untouched';

export function bucketForStatus(status: CoefficientStatus): Bucket {
    switch (status) {
        case 'ok':
        case 'saturated':
        case 'no-effect':
            return 'fitted';
        case 'insufficient-variation':
        case 'did-not-converge':
            return 'needs-attention';
        case 'insufficient-data':
            return 'untouched';
        default: {
            const _exhaustive: never = status;

            return _exhaustive;
        }
    }
}

export interface AxisRow {
    axis: SweepAxis;
    result: CoefficientResult;
}

export interface BucketGroup {
    bucket: Bucket;
    rows: AxisRow[];
}

const BUCKET_ORDER: Bucket[] = ['fitted', 'needs-attention', 'untouched'];

// Every axis appears exactly once; an axis with no rows in the store is reported as
// insufficient-data, n=0 (untouched), so the dashboard always shows all twelve.
export function groupByBucket(coeffs: Map<string, CoefficientResult>): BucketGroup[] {
    const rowsByBucket: Record<Bucket, AxisRow[]> = {fitted: [], 'needs-attention': [], untouched: []};

    for (const axis of ALL_SWEEP_AXES) {
        const result = coeffs.get(axis) ?? {status: 'insufficient-data', n: 0};
        rowsByBucket[bucketForStatus(result.status)].push({axis, result});
    }

    return BUCKET_ORDER.map((bucket) => ({bucket, rows: rowsByBucket[bucket]}));
}

// Sample the fitted logistic P(choose-B) = sigmoid(intercept + slope*x) across
// [xMin, xMax] and emit an SVG path in a width x height box (y inverted for SVG).
export function sigmoidSparklinePath(slope: number, intercept: number, xRange: [number, number], width: number, height: number, samples = 24): string {
    const [xMin, xMax] = xRange;
    const span = xMax - xMin || 1;
    let path = '';
    for (let i = 0; i <= samples; i++) {
        const frac = i / samples;
        const x = xMin + frac * span;
        const p = sigmoid(intercept + slope * x);
        const px = frac * width;
        const py = (1 - p) * height;
        path += `${i === 0 ? 'M' : 'L'}${px.toFixed(2)},${py.toFixed(2)}`;
    }

    return path;
}

export interface CiBarGeometry {
    x: number;
    width: number;
    zeroX: number;
    crossesZero: boolean;
}

// Maps a CI [lo, hi] (in slope units) onto a pixel bar of `pixelWidth`, scaled so
// `scale` slope-units span the half-width. zeroX marks the no-effect line.
export function ciBarGeometry(ci95: [number, number], scale: number, pixelWidth: number): CiBarGeometry {
    const [lo, hi] = ci95;
    const half = pixelWidth / 2;
    const pxPerUnit = scale === 0 ? 0 : half / scale;
    const toPx = (v: number) => half + Math.max(-half, Math.min(half, v * pxPerUnit));
    const x = toPx(lo);
    const width = Math.max(1, toPx(hi) - x);

    return {x, width, zeroX: half, crossesZero: lo <= 0 && hi >= 0};
}
