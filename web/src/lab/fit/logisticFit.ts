// Hand-rolled Firth-penalized one-predictor logistic regression for the
// synthesis-lab coefficient fit. Pure math, no stats dependency. Model:
// logit P(y=1) = a + b*x. Firth's Jeffreys-prior penalty keeps the slope
// finite under complete separation (where plain MLE diverges).

export interface FitPoint {
    x: number;
    y: 0 | 1;
}

export interface LogisticFit {
    intercept: number;
    slope: number;
    // (XtWX)^-1 at the converged estimate, [a, b] order: [[var(a), cov(a,b)], [cov(a,b), var(b)]].
    covariance: [[number, number], [number, number]];
    separated: boolean;
    converged: boolean;
    iterations: number;
}

const MAX_ITERS = 100;
const TOL = 1e-8;

export function sigmoid(z: number): number {
    if (z >= 0) {
        return 1 / (1 + Math.exp(-z));
    }

    const e = Math.exp(z);

    return e / (1 + e);
}

// Complete separation by a threshold on x (or a single label present).
export function isSeparable(points: FitPoint[]): boolean {
    let max0 = -Infinity;
    let min0 = Infinity;
    let max1 = -Infinity;
    let min1 = Infinity;
    for (const {x, y} of points) {
        if (y === 0) {
            max0 = Math.max(max0, x);
            min0 = Math.min(min0, x);
        } else {
            max1 = Math.max(max1, x);
            min1 = Math.min(min1, x);
        }
    }

    if (max0 === -Infinity || max1 === -Infinity) {
        return true;
    }

    return max0 < min1 || max1 < min0;
}

function fisherInverse(points: FitPoint[], a: number, b: number): {inv: [[number, number], [number, number]]; det: number} {
    let s00 = 0;
    let s01 = 0;
    let s11 = 0;
    for (const {x} of points) {
        const p = sigmoid(a + b * x);
        const w = p * (1 - p);
        s00 += w;
        s01 += w * x;
        s11 += w * x * x;
    }

    const det = s00 * s11 - s01 * s01;
    if (!(Math.abs(det) > 0)) {
        return {inv: [[0, 0], [0, 0]], det: 0};
    }

    return {inv: [[s11 / det, -s01 / det], [-s01 / det, s00 / det]], det};
}

export function fitFirthLogistic(points: FitPoint[]): LogisticFit {
    let a = 0;
    let b = 0;
    let converged = false;
    let iterations = 0;
    for (let iter = 1; iter <= MAX_ITERS; iter++) {
        iterations = iter;
        const {inv, det} = fisherInverse(points, a, b);
        if (det === 0) {
            break;
        }

        const [[m00, m01], [, m11]] = inv;
        let u0 = 0;
        let u1 = 0;
        for (const {x, y} of points) {
            const p = sigmoid(a + b * x);
            const w = p * (1 - p);
            const h = w * (m00 + 2 * m01 * x + m11 * x * x);
            const r = (y - p) + h * (0.5 - p);
            u0 += r;
            u1 += r * x;
        }

        const da = m00 * u0 + m01 * u1;
        const db = m01 * u0 + m11 * u1;
        a += da;
        b += db;
        if (Math.max(Math.abs(da), Math.abs(db)) < TOL) {
            converged = true;
            break;
        }
    }

    const {inv} = fisherInverse(points, a, b);

    return {intercept: a, slope: b, covariance: inv, separated: isSeparable(points), converged, iterations};
}
