// Polynomial root finder via Laguerre's method with deflation.
// Finds one root at a time using cubic-convergent iteration on a
// complex-valued initial guess; for real-coefficient polynomials,
// detected complex roots come in conjugate pairs and are deflated
// in one step by dividing out the corresponding real quadratic
// factor x^2 - 2*Re(z)*x + |z|^2.
//
// Laguerre's method is the algorithm Praat (the de-facto reference
// for speech-LPC formant extraction) uses via Numerical Recipes'
// zroots; it converges cubically from almost any starting point and
// is far more robust than Bairstow's quadratic-factor Newton on the
// residual landscapes that LPC polynomials produce.
//
// The polynomial is supplied as coefficients in descending-power
// order: coeffs[0] * x^n + coeffs[1] * x^{n-1} + ... + coeffs[n].
// LPC coefficients in standard form (a[0] = 1, a[1..p]) are already
// in this order if treated as the polynomial z^p * A(z).
//
// Per-instance workspace; not thread-safe. Each call to compute()
// overwrites the public fields.

const MAX_LAGUERRE_ITERATIONS = 80;
const ROOT_TOL = 1e-12;
const STEP_TOL = 1e-12;
// When the imaginary part of a found root is below this absolute
// threshold, treat it as a real root and deflate by a linear factor.
const REAL_ROOT_THRESHOLD = 1e-8;

export interface QuadraticFactor {
    u: number; // factor is x^2 - u*x - v
    v: number;
}

export class PolyRoots {
    private readonly maxOrder: number;
    private readonly factors: QuadraticFactor[];
    private readonly working: Float64Array;
    private readonly nextWorking: Float64Array;
    public factorCount = 0;
    // For odd-order polynomials there is one leftover linear factor
    // (x - residualLinearRoot). NaN when the order is even or the
    // computation has not run.
    public residualLinearRoot = Number.NaN;
    public iterationCount = 0; // total Laguerre iterations across all roots

    public constructor(maxOrder: number) {
        if (maxOrder < 2) {
            throw new Error(`PolyRoots: maxOrder must be >= 2, got ${maxOrder}`);
        }
        this.maxOrder = maxOrder;
        const factorCap = Math.ceil(maxOrder / 2);
        this.factors = Array.from({length: factorCap}, () => ({u: 0, v: 0}));
        // Use Float64 here; LPC coefficients are usually fine in Float32 but
        // intermediate Horner evaluations on complex z accumulate enough
        // round-off that double precision is worth the extra bytes.
        this.working = new Float64Array(maxOrder + 1);
        this.nextWorking = new Float64Array(maxOrder + 1);
    }

    public getFactor(index: number): QuadraticFactor {
        if (index < 0 || index >= this.factorCount) {
            throw new Error(`PolyRoots.getFactor: index ${index} out of range [0, ${this.factorCount})`);
        }

        return this.factors[index];
    }

    public compute(coefficients: ArrayLike<number>): void {
        const order = coefficients.length - 1;
        if (order > this.maxOrder) {
            throw new Error(
                `PolyRoots.compute: order ${order} exceeds maxOrder ${this.maxOrder}`,
            );
        }
        if (order < 1) {
            throw new Error('PolyRoots.compute: order must be >= 1');
        }
        if (coefficients[0] === 0) {
            throw new Error('PolyRoots.compute: leading coefficient must be non-zero');
        }

        const lead = coefficients[0];
        for (let i = 0; i <= order; i++) {
            this.working[i] = coefficients[i] / lead;
        }
        let degree = order;
        this.factorCount = 0;
        this.residualLinearRoot = Number.NaN;
        this.iterationCount = 0;

        while (degree > 0) {
            if (degree === 1) {
                // Linear: x + working[1] = 0 (monic), root = -working[1].
                this.residualLinearRoot = -this.working[1];

                return;
            }
            if (degree === 2) {
                // Quadratic: x^2 + working[1]*x + working[2].
                // Bairstow form is x^2 - u*x - v, so u = -working[1], v = -working[2].
                const factor = this.factors[this.factorCount++];
                factor.u = -this.working[1];
                factor.v = -this.working[2];

                return;
            }

            // Find one root via Laguerre. Start at z = 0.5 + 0.5j; for LPC
            // polynomials this lies inside the unit circle, off the real
            // axis (so Laguerre's denominator selection finds a complex
            // root if one exists, instead of stalling on the real line).
            const root = this.laguerreOneRoot(degree, 0.5, 0.5);
            const re = root.re;
            const im = root.im;

            if (Math.abs(im) < REAL_ROOT_THRESHOLD) {
                // Real root: deflate by (x - re).
                this.deflateLinear(degree, re);
                degree -= 1;
            }
            else {
                // Complex root: deflate by the conjugate-pair quadratic
                // x^2 - 2*re*x + (re^2 + im^2). In Bairstow form: u = 2*re,
                // v = -(re^2 + im^2).
                const factor = this.factors[this.factorCount++];
                factor.u = 2 * re;
                factor.v = -(re * re + im * im);
                this.deflateQuadratic(degree, 2 * re, -(re * re + im * im));
                degree -= 2;
            }
        }
    }

    // Laguerre's method on the working polynomial of given degree, starting
    // from z = startRe + j*startIm. Returns the converged root (re, im).
    private laguerreOneRoot(
        degree: number,
        startRe: number,
        startIm: number,
    ): {re: number; im: number} {
        const coeffs = this.working;
        const n = degree;
        let zRe = startRe;
        let zIm = startIm;

        for (let iter = 0; iter < MAX_LAGUERRE_ITERATIONS; iter++) {
            this.iterationCount++;

            // Horner with first and second derivatives at z (complex).
            // p = coeffs[0]; dp = 0; ddp = 0
            // for k = 1..n:
            //     ddp = ddp * z + 2 * dp
            //     dp = dp * z + p
            //     p = p * z + coeffs[k]
            let pRe = coeffs[0];
            let pIm = 0;
            let dpRe = 0;
            let dpIm = 0;
            let ddpRe = 0;
            let ddpIm = 0;
            for (let k = 1; k <= n; k++) {
                // ddp = ddp * z + 2 * dp
                const newDdpRe = ddpRe * zRe - ddpIm * zIm + 2 * dpRe;
                const newDdpIm = ddpRe * zIm + ddpIm * zRe + 2 * dpIm;
                // dp = dp * z + p
                const newDpRe = dpRe * zRe - dpIm * zIm + pRe;
                const newDpIm = dpRe * zIm + dpIm * zRe + pIm;
                // p = p * z + coeffs[k]
                const newPRe = pRe * zRe - pIm * zIm + coeffs[k];
                const newPIm = pRe * zIm + pIm * zRe;
                ddpRe = newDdpRe;
                ddpIm = newDdpIm;
                dpRe = newDpRe;
                dpIm = newDpIm;
                pRe = newPRe;
                pIm = newPIm;
            }

            const pMag2 = pRe * pRe + pIm * pIm;
            if (pMag2 < ROOT_TOL * ROOT_TOL) {
                return {re: zRe, im: zIm};
            }

            // G = dp / p (complex)
            // G = (dp * conj(p)) / |p|^2
            const gRe = (dpRe * pRe + dpIm * pIm) / pMag2;
            const gIm = (dpIm * pRe - dpRe * pIm) / pMag2;

            // H = G^2 - ddp / p
            const g2Re = gRe * gRe - gIm * gIm;
            const g2Im = 2 * gRe * gIm;
            const ddpOverPRe = (ddpRe * pRe + ddpIm * pIm) / pMag2;
            const ddpOverPIm = (ddpIm * pRe - ddpRe * pIm) / pMag2;
            const hRe = g2Re - ddpOverPRe;
            const hIm = g2Im - ddpOverPIm;

            // term = (n - 1) * (n * H - G^2)
            const termRe = (n - 1) * (n * hRe - g2Re);
            const termIm = (n - 1) * (n * hIm - g2Im);

            // sqrtTerm = sqrt(term) (complex)
            const termMag = Math.hypot(termRe, termIm);
            const sqrtTermRe = Math.sqrt((termMag + termRe) / 2);
            const sqrtTermImAbs = Math.sqrt(Math.max(0, (termMag - termRe) / 2));
            const sqrtTermIm = termIm >= 0 ? sqrtTermImAbs : -sqrtTermImAbs;

            // Pick the larger-magnitude denominator (G + sqrtTerm) vs (G - sqrtTerm).
            const denomPlusRe = gRe + sqrtTermRe;
            const denomPlusIm = gIm + sqrtTermIm;
            const denomMinusRe = gRe - sqrtTermRe;
            const denomMinusIm = gIm - sqrtTermIm;
            const magPlus2 = denomPlusRe * denomPlusRe + denomPlusIm * denomPlusIm;
            const magMinus2 = denomMinusRe * denomMinusRe + denomMinusIm * denomMinusIm;
            let denomRe: number;
            let denomIm: number;
            if (magPlus2 >= magMinus2) {
                denomRe = denomPlusRe;
                denomIm = denomPlusIm;
            }
            else {
                denomRe = denomMinusRe;
                denomIm = denomMinusIm;
            }

            const denomMag2 = denomRe * denomRe + denomIm * denomIm;
            if (denomMag2 < 1e-30) {
                // Both denominators tiny: nudge z and retry.
                zRe += 0.1;
                zIm += 0.1;
                continue;
            }

            // a = n / denom (complex)
            const aRe = n * denomRe / denomMag2;
            const aIm = -n * denomIm / denomMag2;

            zRe -= aRe;
            zIm -= aIm;

            const stepMag2 = aRe * aRe + aIm * aIm;
            if (stepMag2 < STEP_TOL * STEP_TOL) {
                return {re: zRe, im: zIm};
            }
        }

        // Did not converge; return last estimate.
        return {re: zRe, im: zIm};
    }

    // Deflate the working polynomial by (x - root). Synthetic division:
    // q[0] = working[0], q[k] = working[k] + root * q[k-1] for k = 1..degree-1.
    // Remainder q[degree] should be ~0.
    private deflateLinear(degree: number, root: number): void {
        const w = this.working;
        const next = this.nextWorking;
        next[0] = w[0];
        for (let k = 1; k < degree; k++) {
            next[k] = w[k] + root * next[k - 1];
        }
        for (let k = 0; k < degree; k++) {
            w[k] = next[k];
        }
    }

    // Deflate by x^2 - u*x - v. Synthetic division:
    // q[0] = working[0]
    // q[1] = working[1] + u * q[0]
    // q[k] = working[k] + u * q[k-1] + v * q[k-2] for k = 2..degree-2
    // (Remainder b[degree-1] and b[degree] should be ~0.)
    private deflateQuadratic(degree: number, u: number, v: number): void {
        const w = this.working;
        const next = this.nextWorking;
        next[0] = w[0];
        if (degree >= 2) {
            next[1] = w[1] + u * next[0];
        }
        for (let k = 2; k < degree - 1; k++) {
            next[k] = w[k] + u * next[k - 1] + v * next[k - 2];
        }
        for (let k = 0; k < degree - 1; k++) {
            w[k] = next[k];
        }
    }
}

// Helpers for converting Bairstow-form factors (x^2 - u*x - v) to
// (frequency, bandwidth) in the formant sense.

export interface PoleInfo {
    isComplex: boolean;
    magnitude: number;
    angle: number; // 0..pi for complex pair (positive frequency)
    real1: number; // valid only when isComplex === false
    real2: number; // valid only when isComplex === false
}

const tmpPoleInfo: PoleInfo = {
    isComplex: false,
    magnitude: 0,
    angle: 0,
    real1: 0,
    real2: 0,
};

export function factorToPole(u: number, v: number): PoleInfo {
    const discriminant = u * u + 4 * v;
    if (discriminant < 0) {
        const mag = Math.sqrt(-v);
        const cosTheta = u / (2 * mag);
        const clamped = cosTheta > 1 ? 1 : cosTheta < -1 ? -1 : cosTheta;
        tmpPoleInfo.isComplex = true;
        tmpPoleInfo.magnitude = mag;
        tmpPoleInfo.angle = Math.acos(clamped);
        tmpPoleInfo.real1 = 0;
        tmpPoleInfo.real2 = 0;
    }
    else {
        const sq = Math.sqrt(discriminant);
        tmpPoleInfo.isComplex = false;
        tmpPoleInfo.magnitude = 0;
        tmpPoleInfo.angle = 0;
        tmpPoleInfo.real1 = (u + sq) / 2;
        tmpPoleInfo.real2 = (u - sq) / 2;
    }

    return tmpPoleInfo;
}
