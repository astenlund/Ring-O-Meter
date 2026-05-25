import {IDBFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it} from 'vitest';
import {mulberry32} from '../synth/seededRng';
import {neutralVoiceParams, type ChordParams} from '../synth/voiceParams';
import {makeCalibrationTrial, type CalibrationTrial, type NewTrialInput, type TrialChoice} from '../store/calibrationTrial';
import {openCalibrationStoreForTest} from '../store/calibrationStore';
import {fitCoefficients, computeCalibration} from './coefficients';

function chord(): ChordParams {
    return {voices: [neutralVoiceParams(220)]};
}

let counter = 0;
function row(axis: string | null, delta: number | null, choice: TrialChoice, selectorMode: 'sweep' | 'random' = 'sweep'): CalibrationTrial {
    counter += 1;
    const input: NewTrialInput = {
        trialId: `t${counter}`,
        sessionId: 's1',
        listenerId: 'l1',
        selectorMode,
        sweepAxis: axis,
        sweepDelta: delta,
        chordA: chord(),
        chordB: chord(),
        seedA: 1,
        seedB: 2,
        choice,
        timestampMs: counter,
    };

    return makeCalibrationTrial(input);
}

// A strong, well-sampled monotonic sweep on one axis: P(choose B) rises with delta.
function strongSweep(axis: string, perX: number, seed: number): CalibrationTrial[] {
    const rng = mulberry32(seed);
    const rows: CalibrationTrial[] = [];
    for (const delta of [-3, -2, -1, 1, 2, 3]) {
        const p = 1 / (1 + Math.exp(-(1.5 * delta)));
        for (let k = 0; k < perX; k++) {
            rows.push(row(axis, delta, rng() < p ? 'B' : 'A'));
        }
    }

    return rows;
}

beforeEach(() => {
    counter = 0;
});

describe('fitCoefficients', () => {
    it('excludes random-selector and tie rows, groups by sweepAxis', () => {
        // Arrange
        const rows = [
            ...strongSweep('pitchVariance.drift', 5, 11),
            row(null, null, 'A', 'random'),
            row('pitchVariance.drift', 2, 'tie'),
        ];

        // Act
        const result = fitCoefficients(rows);

        // Assert: only the one swept axis appears; ties/random excluded from its n
        expect([...result.keys()]).toEqual(['pitchVariance.drift']);
        expect(result.get('pitchVariance.drift')!.n).toBe(30);
    });

    it('reports insufficient-data below the floor', () => {
        // Arrange: 10 decisive rows
        const rows = Array.from({length: 10}, (_v, i) => row('x', i % 2 === 0 ? 1 : -1, 'B'));

        // Act
        const r = fitCoefficients(rows).get('x')!;

        // Assert
        expect(r.status).toBe('insufficient-data');
        expect(r.n).toBe(10);
    });

    it('reports insufficient-variation when all deltas are identical', () => {
        // Arrange: 25 decisive rows, all at delta = 1
        const rows = Array.from({length: 25}, (_v, i) => row('x', 1, i % 2 === 0 ? 'A' : 'B'));

        // Act
        const r = fitCoefficients(rows).get('x')!;

        // Assert
        expect(r.status).toBe('insufficient-variation');
        expect(r.n).toBe(25);
    });

    it('reports saturated for perfectly-separated decisive choices', () => {
        // Arrange: 30 rows, delta<0 -> A, delta>0 -> B (separable)
        const rows: CalibrationTrial[] = [];
        for (const delta of [-2, -1]) {
            for (let k = 0; k < 8; k++) {
                rows.push(row('x', delta, 'A'));
            }
        }
        for (const delta of [1, 2]) {
            for (let k = 0; k < 7; k++) {
                rows.push(row('x', delta, 'B'));
            }
        }

        // Act
        const r = fitCoefficients(rows).get('x')!;

        // Assert
        expect(r.status).toBe('saturated');
        expect(r.n).toBe(30);
        if (r.status === 'saturated') {
            expect(Number.isFinite(r.slope)).toBe(true);
        }
    });

    it('reports no-effect when choice is independent of delta', () => {
        // Arrange: 200 decisive rows, equal A and B at each delta. Balanced by
        // construction (not random), so the slope is mechanically ~0 and the CI is
        // symmetric around 0 for any build - no seed dependence, no 5% null-coverage tail.
        const rows: CalibrationTrial[] = [];
        for (const delta of [-2, 2]) {
            for (let k = 0; k < 50; k++) {
                rows.push(row('x', delta, 'A'));
                rows.push(row('x', delta, 'B'));
            }
        }

        // Act
        const r = fitCoefficients(rows).get('x')!;

        // Assert
        expect(r.status).toBe('no-effect');
    });

    it('reports ok with a positive slope for a strong monotonic sweep', () => {
        // Arrange
        const rows = strongSweep('x', 60, 9);

        // Act
        const r = fitCoefficients(rows).get('x')!;

        // Assert
        expect(r.status).toBe('ok');
        if (r.status === 'ok') {
            expect(r.slope).toBeGreaterThan(0);
            expect(r.ci95[0]).toBeGreaterThan(0);
            expect(r.covariance.length).toBe(2);
        }
    });
});

describe('computeCalibration', () => {
    let factory: IDBFactory;

    beforeEach(() => {
        factory = new IDBFactory();
    });

    it('reads the store and carries skippedMalformedCount through', async () => {
        // Arrange
        const store = await openCalibrationStoreForTest(factory);
        for (const r of strongSweep('x', 60, 3)) {
            await store.addTrial(r);
        }
        await store.putRaw({trialId: 'bad', sessionId: 's1'});

        // Act
        const {coefficients, skippedMalformedCount} = await computeCalibration(store);
        store.close();

        // Assert
        expect(skippedMalformedCount).toBe(1);
        expect(coefficients.get('x')!.status).toBe('ok');
    });
});
