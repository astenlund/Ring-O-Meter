import {describe, it, expect} from 'vitest';
import {bucketForStatus, groupByBucket, sigmoidSparklinePath, ciBarGeometry} from './coefficientView';
import type {CoefficientResult} from '../fit/coefficients';

function fitted(status: 'ok' | 'saturated' | 'no-effect', slope: number): CoefficientResult {
    return {status, n: 30, slope, ci95: [slope - 0.1, slope + 0.1], intercept: 0, covariance: [[0, 0], [0, 0]]};
}

describe('bucketForStatus', () => {
    it('maps each status to its band', () => {
        // Arrange / Act / Assert
        expect(bucketForStatus('ok')).toBe('fitted');
        expect(bucketForStatus('saturated')).toBe('fitted');
        expect(bucketForStatus('no-effect')).toBe('fitted');
        expect(bucketForStatus('insufficient-variation')).toBe('needs-attention');
        expect(bucketForStatus('did-not-converge')).toBe('needs-attention');
        expect(bucketForStatus('insufficient-data')).toBe('untouched');
    });
});

describe('groupByBucket', () => {
    it('orders fitted -> needs-attention -> untouched and fills untouched for missing axes', () => {
        // Arrange
        const coeffs = new Map<string, CoefficientResult>([
            ['fundamental', fitted('ok', 0.5)],
            ['vibrato.depth', {status: 'did-not-converge', n: 25}],
        ]);

        // Act
        const groups = groupByBucket(coeffs);

        // Assert
        expect(groups.map((g) => g.bucket)).toEqual(['fitted', 'needs-attention', 'untouched']);
        // Every axis appears exactly once across the three buckets.
        const all = groups.flatMap((g) => g.rows.map((r) => r.axis));
        expect(new Set(all).size).toBe(all.length);
        expect(all).toContain('onset'); // an untouched axis with no row -> insufficient-data, n=0
        const onset = groups.flatMap((g) => g.rows).find((r) => r.axis === 'onset')!;
        expect(onset.result.status).toBe('insufficient-data');
        expect(onset.result.n).toBe(0);
    });
});

describe('sigmoidSparklinePath', () => {
    it('returns a non-empty SVG path string', () => {
        // Arrange / Act
        const path = sigmoidSparklinePath(0.5, 0, [-20, 20], 80, 24);

        // Assert
        expect(path.startsWith('M')).toBe(true);
        expect(path.length).toBeGreaterThan(10);
    });
});

describe('ciBarGeometry', () => {
    it('flags a CI that crosses zero', () => {
        // Arrange / Act
        const g = ciBarGeometry([-0.2, 0.3], 1, 100);

        // Assert
        expect(g.crossesZero).toBe(true);
    });

    it('flags a CI entirely above zero as not crossing', () => {
        // Arrange / Act
        const g = ciBarGeometry([0.1, 0.4], 1, 100);

        // Assert
        expect(g.crossesZero).toBe(false);
        expect(g.width).toBeGreaterThan(0);
    });
});
