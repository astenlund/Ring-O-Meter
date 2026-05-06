import {describe, expect, it} from 'vitest';

import {PolyRoots, factorToPole} from './polyRoots';

describe('PolyRoots', () => {
    it('finds roots of a known quadratic with complex conjugate pair', () => {
        // Arrange: (z - 0.9*e^{i*0.628})(z - 0.9*e^{-i*0.628})
        //        = z^2 - 2*0.9*cos(0.628)*z + 0.81
        //        = z^2 - 1.456*z + 0.81
        const r = 0.9;
        const theta = 0.628;
        const u = 2 * r * Math.cos(theta);
        const v = -r * r;
        const coeffs = [1, -u, -v]; // x^2 - u*x - v -> [1, -u, -v] in descending-power form

        // Act
        const roots = new PolyRoots(2);
        roots.compute(coeffs);

        // Assert
        expect(roots.factorCount).toBe(1);
        const factor = roots.getFactor(0);
        expect(factor.u).toBeCloseTo(u, 4);
        expect(factor.v).toBeCloseTo(v, 4);
        const pole = factorToPole(factor.u, factor.v);
        expect(pole.isComplex).toBe(true);
        expect(pole.magnitude).toBeCloseTo(r, 4);
        expect(pole.angle).toBeCloseTo(theta, 4);
    });

    it('finds roots of a degree-4 polynomial with two complex pairs', () => {
        // Arrange: two distinct conjugate pairs at (r1, theta1) and (r2, theta2).
        // Combined polynomial = (z^2 - u1*z - v1)(z^2 - u2*z - v2).
        const r1 = 0.9;
        const t1 = 0.5;
        const u1 = 2 * r1 * Math.cos(t1);
        const v1 = -r1 * r1;
        const r2 = 0.85;
        const t2 = 1.4;
        const u2 = 2 * r2 * Math.cos(t2);
        const v2 = -r2 * r2;

        // Multiply (x^2 - u1*x - v1)(x^2 - u2*x - v2) out manually.
        // = x^4 - (u1+u2)*x^3 + (u1*u2 - v1 - v2)*x^2 + (u1*v2 + u2*v1)*x + v1*v2
        const c0 = 1;
        const c1 = -(u1 + u2);
        const c2 = u1 * u2 - v1 - v2;
        const c3 = u1 * v2 + u2 * v1;
        const c4 = v1 * v2;
        const coeffs = [c0, c1, c2, c3, c4];

        // Act
        const roots = new PolyRoots(4);
        roots.compute(coeffs);

        // Assert: should find two factors. Their (u, v) should match the
        // two true factors in some order.
        expect(roots.factorCount).toBe(2);
        const found = [
            {u: roots.getFactor(0).u, v: roots.getFactor(0).v},
            {u: roots.getFactor(1).u, v: roots.getFactor(1).v},
        ];
        const matches = (a: {u: number; v: number}, b: {u: number; v: number}): boolean => {
            return Math.abs(a.u - b.u) < 1e-3 && Math.abs(a.v - b.v) < 1e-3;
        };
        const true1 = {u: u1, v: v1};
        const true2 = {u: u2, v: v2};
        const orderA = matches(found[0], true1) && matches(found[1], true2);
        const orderB = matches(found[0], true2) && matches(found[1], true1);
        expect(orderA || orderB).toBe(true);
    });

    it('handles odd-order polynomials (residual linear factor)', () => {
        // Arrange: (z^2 - u*z - v)(z - 0.5)
        //        = z^3 - u*z^2 - v*z - 0.5*z^2 + 0.5*u*z + 0.5*v
        //        = z^3 + (-u - 0.5)*z^2 + (-v + 0.5*u)*z + 0.5*v
        const r = 0.9;
        const theta = 0.628;
        const u = 2 * r * Math.cos(theta);
        const v = -r * r;
        const realRoot = 0.5;
        const c0 = 1;
        const c1 = -u - realRoot;
        const c2 = -v + realRoot * u;
        const c3 = realRoot * v;
        const coeffs = [c0, c1, c2, c3];

        // Act
        const roots = new PolyRoots(3);
        roots.compute(coeffs);

        // Assert
        expect(roots.factorCount).toBe(1);
        expect(roots.residualLinearRoot).toBeCloseTo(realRoot, 4);
        const factor = roots.getFactor(0);
        expect(factor.u).toBeCloseTo(u, 4);
        expect(factor.v).toBeCloseTo(v, 4);
    });

    it('finds roots of a degree-10 LPC polynomial within a few hundred iterations', () => {
        // Arrange: 5 distinct complex conjugate pairs at increasing angles.
        const pairs = [
            {r: 0.95, theta: 0.1},
            {r: 0.92, theta: 0.4},
            {r: 0.88, theta: 0.9},
            {r: 0.85, theta: 1.5},
            {r: 0.80, theta: 2.5},
        ];
        // Build the polynomial by multiplying out the quadratic factors.
        let coeffs = [1];
        for (const p of pairs) {
            const u = 2 * p.r * Math.cos(p.theta);
            const v = -p.r * p.r;
            const newCoeffs = new Array<number>(coeffs.length + 2).fill(0);
            for (let i = 0; i < coeffs.length; i++) {
                newCoeffs[i] += coeffs[i];
                newCoeffs[i + 1] += -u * coeffs[i];
                newCoeffs[i + 2] += -v * coeffs[i];
            }
            coeffs = newCoeffs;
        }

        // Act
        const roots = new PolyRoots(10);
        roots.compute(coeffs);

        // Assert: 5 factors found.
        expect(roots.factorCount).toBe(5);
        // Each factor's pole magnitude/angle should match one of the input pairs.
        const foundPoles = [];
        for (let i = 0; i < roots.factorCount; i++) {
            const f = roots.getFactor(i);
            const p = factorToPole(f.u, f.v);
            expect(p.isComplex).toBe(true);
            foundPoles.push({r: p.magnitude, theta: p.angle});
        }
        for (const truePair of pairs) {
            const match = foundPoles.find((p) => {
                return Math.abs(p.r - truePair.r) < 1e-3 && Math.abs(p.theta - truePair.theta) < 1e-3;
            });
            expect(match, `expected to find pair r=${truePair.r}, theta=${truePair.theta}`).toBeTruthy();
        }
        expect(roots.iterationCount).toBeLessThan(500);
    });

    it('handles real-root quadratic factor', () => {
        // Arrange: (x - 0.6)(x - 0.4) = x^2 - x + 0.24
        const coeffs = [1, -1, 0.24];

        // Act
        const roots = new PolyRoots(2);
        roots.compute(coeffs);

        // Assert
        expect(roots.factorCount).toBe(1);
        const factor = roots.getFactor(0);
        const pole = factorToPole(factor.u, factor.v);
        expect(pole.isComplex).toBe(false);
        // Two real roots; should be 0.6 and 0.4 in some order.
        const reals = [pole.real1, pole.real2].sort();
        expect(reals[0]).toBeCloseTo(0.4, 5);
        expect(reals[1]).toBeCloseTo(0.6, 5);
    });
});
