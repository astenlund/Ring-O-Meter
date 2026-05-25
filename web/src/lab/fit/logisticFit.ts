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

const CHI2_HALF_95 = 1.9207; // chiSquare(1, 0.95) / 2

function log1pExp(z: number): number {
    // stable log(1 + e^z)
    if (z > 0) {
        return z + Math.log1p(Math.exp(-z));
    }

    return Math.log1p(Math.exp(z));
}

// Penalized log-likelihood maximized over `a` at fixed `b` (Newton on a).
function penalizedProfileLogLik(points: FitPoint[], b: number): number {
    let a = 0;
    for (let iter = 0; iter < 50; iter++) {
        let s00 = 0;
        let u0 = 0;
        for (const {x, y} of points) {
            const p = sigmoid(a + b * x);
            const w = p * (1 - p);
            s00 += w;
            // Firth-adjusted a-score uses the marginal hat term; for the 1-D
            // a-maximization the plain score is adequate and converges.
            u0 += y - p;
        }

        if (s00 === 0) {
            break;
        }

        const da = u0 / s00;
        a += da;
        if (Math.abs(da) < TOL) {
            break;
        }
    }

    let ll = 0;
    let s00 = 0;
    let s01 = 0;
    let s11 = 0;
    for (const {x, y} of points) {
        const eta = a + b * x;
        ll += y * eta - log1pExp(eta);
        const p = sigmoid(eta);
        const w = p * (1 - p);
        s00 += w;
        s01 += w * x;
        s11 += w * x * x;
    }

    const det = s00 * s11 - s01 * s01;

    return ll + 0.5 * Math.log(Math.max(det, Number.MIN_VALUE));
}

export function slopeCi95(points: FitPoint[]): [number, number] {
    const fit = fitFirthLogistic(points);
    const bHat = fit.slope;
    const target = penalizedProfileLogLik(points, bHat) - CHI2_HALF_95;
    // step scale from the Wald SE, with a floor so it is never degenerate
    const seB = Math.sqrt(Math.max(fit.covariance[1][1], 1e-6));
    const step = Math.max(seB, 0.1);

    const findRoot = (direction: 1 | -1): number => {
        let near = bHat;
        let far = bHat;
        let bracketed = false;
        for (let i = 0; i < 60; i++) {
            far = bHat + direction * step * (i + 1);
            if (penalizedProfileLogLik(points, far) < target) {
                bracketed = true;
                break;
            }

            near = far;
        }

        // If the profile never dropped below target within the search window, the CI is
        // unbounded on this side. Report it honestly as +/-Infinity rather than returning
        // the midpoint of a non-bracketing interval (a finite but fabricated bound). The
        // Firth penalty guarantees a root exists for real overlapping/separated data, so
        // this is a defensive path; the consumer's no-effect test (ci95 straddles 0) and
        // Number.isFinite(slope) assertions both compose correctly with an infinite bound.
        if (!bracketed) {
            return direction === -1 ? -Infinity : Infinity;
        }

        for (let i = 0; i < 100; i++) {
            const mid = (near + far) / 2;
            if (penalizedProfileLogLik(points, mid) < target) {
                far = mid;
            } else {
                near = mid;
            }
        }

        return (near + far) / 2;
    };

    return [findRoot(-1), findRoot(1)];
}
