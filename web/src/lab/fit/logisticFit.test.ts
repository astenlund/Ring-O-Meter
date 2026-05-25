import {describe, expect, it} from 'vitest';
import {mulberry32} from '../synth/seededRng';
import {fitFirthLogistic, isSeparable, slopeCi95, type FitPoint} from './logisticFit';

// Generate y_i ~ Bernoulli(sigmoid(a + b*x_i)) over a fixed x-grid, seeded.
function synth(a: number, b: number, perX: number, seed: number): FitPoint[] {
    const rng = mulberry32(seed);
    const xs = [-3, -2, -1, -0.5, 0.5, 1, 2, 3];
    const points: FitPoint[] = [];
    for (const x of xs) {
        const p = 1 / (1 + Math.exp(-(a + b * x)));
        for (let k = 0; k < perX; k++) {
            points.push({x, y: rng() < p ? 1 : 0});
        }
    }

    return points;
}

describe('fitFirthLogistic', () => {
    it('recovers a known slope and intercept from seeded synthetic data', () => {
        // Arrange: true a=0, b=1.5, large sample
        const points = synth(0, 1.5, 400, 1);

        // Act
        const fit = fitFirthLogistic(points);

        // Assert: recovered within a loose tolerance (Firth shrinks slightly toward 0).
        // Intercept asserted as a band, not toBeCloseTo(0, 1): the recovered intercept's
        // spread across seeds (sd ~0.055) exceeds toBeCloseTo's 0.05 tolerance, so the
        // digit form would flake on a re-seed; |intercept| < 0.3 is robust and still meaningful.
        expect(fit.converged).toBe(true);
        expect(Math.abs(fit.intercept)).toBeLessThan(0.3);
        expect(fit.slope).toBeGreaterThan(1.2);
        expect(fit.slope).toBeLessThan(1.8);
        expect(fit.separated).toBe(false);
    });

    it('flips the slope sign when all choices flip', () => {
        // Arrange
        const points = synth(0, 1.5, 200, 2);
        const flipped = points.map((p) => ({x: p.x, y: (1 - p.y) as 0 | 1}));

        // Act
        const a = fitFirthLogistic(points);
        const b = fitFirthLogistic(flipped);

        // Assert
        expect(Math.sign(a.slope)).toBe(-Math.sign(b.slope));
    });

    it('returns a finite slope on perfectly separated data (Firth) and flags separated', () => {
        // Arrange: every x<0 chose 0, every x>0 chose 1
        const points: FitPoint[] = [];
        for (const x of [-3, -2, -1]) {
            for (let k = 0; k < 10; k++) {
                points.push({x, y: 0});
            }
        }
        for (const x of [1, 2, 3]) {
            for (let k = 0; k < 10; k++) {
                points.push({x, y: 1});
            }
        }

        // Act
        const fit = fitFirthLogistic(points);

        // Assert: plain MLE would diverge; Firth stays finite, and separation is flagged
        expect(Number.isFinite(fit.slope)).toBe(true);
        expect(fit.slope).toBeGreaterThan(0);
        expect(fit.separated).toBe(true);
    });

    it('detects separation across same-sign x values (threshold, not sign)', () => {
        // Arrange: all x positive; +5 -> 0, +10 -> 1 (separable by a threshold at 7.5)
        const points: FitPoint[] = [];
        for (let k = 0; k < 10; k++) {
            points.push({x: 5, y: 0});
            points.push({x: 10, y: 1});
        }

        // Act / Assert
        expect(isSeparable(points)).toBe(true);
    });

    it('is not separable when labels overlap on x', () => {
        // Arrange
        const points: FitPoint[] = [
            {x: 1, y: 0}, {x: 1, y: 1}, {x: 2, y: 0}, {x: 2, y: 1},
        ];

        // Act / Assert
        expect(isSeparable(points)).toBe(false);
    });

    it('treats empty and single-label input as separable', () => {
        // Arrange / Act / Assert: degenerate inputs have no label overlap to fit through
        expect(isSeparable([])).toBe(true);
        expect(isSeparable([{x: 1, y: 0}, {x: 2, y: 0}])).toBe(true);
        expect(isSeparable([{x: 1, y: 1}, {x: 2, y: 1}])).toBe(true);
    });
});

describe('slopeCi95', () => {
    it('brackets the point estimate', () => {
        // Arrange
        const points = synth(0, 1.5, 300, 3);
        const fit = fitFirthLogistic(points);

        // Act
        const [lo, hi] = slopeCi95(points);

        // Assert
        expect(lo).toBeLessThan(fit.slope);
        expect(hi).toBeGreaterThan(fit.slope);
    });

    it('includes zero for a balanced (choice-independent) dataset', () => {
        // Arrange: equal y=0 and y=1 at every x -> the slope is mechanically 0 and the CI
        // is symmetric around 0. Balanced-by-construction (not a seeded null draw): a single
        // pinned seed has a ~5% chance of a false exclusion (a 95% CI misses the true value
        // ~5% of the time by construction, and more data tightens around the *realized*
        // sample slope, not the true 0), so the straddle is only guaranteed when the data
        // carries no effect by construction.
        const points: FitPoint[] = [];
        for (const x of [-3, -2, -1, -0.5, 0.5, 1, 2, 3]) {
            for (let k = 0; k < 40; k++) {
                points.push({x, y: 0});
                points.push({x, y: 1});
            }
        }

        // Act
        const [lo, hi] = slopeCi95(points);

        // Assert
        expect(lo).toBeLessThanOrEqual(0);
        expect(hi).toBeGreaterThanOrEqual(0);
    });

    it('excludes zero and is narrower with more data for a strong effect', () => {
        // Arrange
        const small = slopeCi95(synth(0, 1.5, 60, 5));
        const large = slopeCi95(synth(0, 1.5, 600, 5));

        // Assert: strong effect, large sample -> CI well above 0 and tighter
        expect(large[0]).toBeGreaterThan(0);
        expect(large[1] - large[0]).toBeLessThan(small[1] - small[0]);
    });
});
