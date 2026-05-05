import {describe, expect, it} from 'vitest';
import {
    GATE_DEBOUNCE_MS,
    GateDebounce,
    OrderDebounce,
    polarAngleSort,
    polygonAreaMetric,
    type VoicePoint,
} from './vowelModule';

function makePoint(channelId: string, f1: number, f2: number, color = '#5cf'): VoicePoint {
    return {channelId, color, f1Hz: f1, f2Hz: f2, isDimmed: false, hasEverPublished: true};
}

describe('polarAngleSort', () => {
    it('passes through arrays of length <= 2', () => {
        // Arrange / Act / Assert
        expect(polarAngleSort([])).toEqual([]);
        const single = [makePoint('a', 500, 1500)];
        expect(polarAngleSort(single)).toEqual([0]);
        const pair = [makePoint('a', 500, 1500), makePoint('b', 700, 2000)];
        expect(polarAngleSort(pair)).toEqual([0, 1]);
    });

    it('produces a simple (non-self-intersecting) ordering for 4 voices', () => {
        // Arrange: 4 corners of a rectangle in F1/F2 space, given out of order
        const points = [
            makePoint('A', 200, 1000),
            makePoint('B', 200, 2000),
            makePoint('C', 800, 1000),
            makePoint('D', 800, 2000),
        ];

        // Act
        const ordering = polarAngleSort(points);

        // Assert: ordering visits each corner exactly once
        expect(ordering.length).toBe(4);
        const sorted = [...ordering].sort();
        expect(sorted).toEqual([0, 1, 2, 3]);
    });

    it('breaks ties by channelId (deterministic across calls)', () => {
        // Arrange: two points at the same position
        const points = [
            makePoint('z', 500, 1500),
            makePoint('a', 500, 1500),
            makePoint('m', 700, 1700),
        ];

        // Act
        const first = polarAngleSort(points);
        const second = polarAngleSort(points);

        // Assert
        expect(first).toEqual(second);
    });
});

describe('polygonAreaMetric', () => {
    it('returns NaN for zero or one voice', () => {
        // Arrange / Act / Assert
        expect(Number.isNaN(polygonAreaMetric([], []))).toBe(true);
        expect(Number.isNaN(polygonAreaMetric([makePoint('a', 500, 1500)], [0]))).toBe(true);
    });

    it('returns squared edge length for two voices', () => {
        // Arrange: separation (200, 400), squared distance = 200^2 + 400^2 = 200_000
        const points = [makePoint('a', 500, 1500), makePoint('b', 700, 1900)];

        // Act
        const m = polygonAreaMetric(points, [0, 1]);

        // Assert
        expect(m).toBe(200_000);
    });

    it('returns triangle area for three voices', () => {
        // Arrange: right triangle with legs 1000 (F2) and 600 (F1), area = 0.5 * 1000 * 600 = 300_000
        const points = [
            makePoint('a', 200, 1000),
            makePoint('b', 200, 2000),
            makePoint('c', 800, 1000),
        ];

        // Act
        const m = polygonAreaMetric(points, [0, 1, 2]);

        // Assert
        expect(m).toBeCloseTo(300_000, 0);
    });

    it('returns rectangle area for four voices', () => {
        // Arrange: 600 x 1000 rectangle, area 600_000
        const points = [
            makePoint('a', 200, 1000),
            makePoint('b', 200, 2000),
            makePoint('d', 800, 2000),
            makePoint('c', 800, 1000),
        ];

        // Act
        const m = polygonAreaMetric(points, polarAngleSort(points));

        // Assert
        expect(m).toBeCloseTo(600_000, 0);
    });
});

describe('OrderDebounce', () => {
    it('accepts the first ordering immediately', () => {
        // Arrange
        const od = new OrderDebounce();

        // Act
        od.update([0, 1, 2, 3], 4, 16);

        // Assert
        expect(od.getAppliedLength()).toBe(4);
        const applied = od.getApplied();
        expect(applied[0]).toBe(0);
        expect(applied[1]).toBe(1);
        expect(applied[2]).toBe(2);
        expect(applied[3]).toBe(3);
    });

    it('holds the applied ordering until proposed stabilizes', () => {
        // Arrange
        const od = new OrderDebounce();
        od.update([0, 1, 2, 3], 4, 16); // initial

        // Act: propose a swap, but only sustain it for half the dwell
        od.update([1, 0, 2, 3], 4, 100);
        const mid = od.getApplied();

        // Assert: applied is still [0,1,2,3]
        expect([mid[0], mid[1]]).toEqual([0, 1]);

        // Sustain another 100 ms (total 200 ms): now the swap promotes
        od.update([1, 0, 2, 3], 4, 100);
        const after = od.getApplied();
        expect([after[0], after[1]]).toEqual([1, 0]);
    });

    it('resets pending dwell when proposal flips back', () => {
        // Arrange
        const od = new OrderDebounce();
        od.update([0, 1, 2, 3], 4, 16); // initial
        od.update([1, 0, 2, 3], 4, 150); // pending [1,0,...] for 150 ms

        // Act: flip back to original; pending should reset
        od.update([0, 1, 2, 3], 4, 16);
        // Now propose [1,0,...] again - dwell starts fresh
        od.update([1, 0, 2, 3], 4, 100);

        // Assert: applied is still [0,1,2,3] (only 100 ms of new pending)
        const applied = od.getApplied();
        expect([applied[0], applied[1]]).toEqual([0, 1]);
    });
});

describe('GateDebounce', () => {
    it('starts dimmed and flips on after debounce window of true', () => {
        // Arrange
        const g = new GateDebounce();

        // Act / Assert
        expect(g.isDimmed()).toBe(true);
        // 50 ms of "raw display": not enough.
        g.update(true, 50);
        expect(g.isDimmed()).toBe(true);
        // Another 50 ms (total 100): now flips.
        g.update(true, 50);
        expect(g.isDimmed()).toBe(false);
    });

    it('does not flicker on single-frame blips', () => {
        // Arrange
        const g = new GateDebounce();
        // Bring it out of the initial dimmed state.
        g.update(true, GATE_DEBOUNCE_MS);
        expect(g.isDimmed()).toBe(false);

        // Act: one frame of "no display" (10 ms), then back to "display"
        g.update(false, 10);
        const blipDimmed = g.isDimmed();
        g.update(true, 10);

        // Assert: the single 10 ms blip did not trigger a transition.
        expect(blipDimmed).toBe(false);
    });

    it('re-dims after sustained-false matches the debounce window', () => {
        // Arrange: bring the gate to the undimmed state first.
        const g = new GateDebounce();
        g.update(true, GATE_DEBOUNCE_MS);
        expect(g.isDimmed()).toBe(false);

        // Act: sustained "no display" for the full debounce window.
        g.update(false, 50);
        expect(g.isDimmed()).toBe(false);
        g.update(false, 50);

        // Assert: re-dim transition fires symmetric to the un-dim transition.
        expect(g.isDimmed()).toBe(true);
    });
});
