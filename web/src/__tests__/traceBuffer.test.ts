import {describe, expect, it} from 'vitest';
import {TraceBuffer} from '../session/traceBuffer';

describe('TraceBuffer', () => {
    it('iterates pushed samples in order when below capacity', () => {
        // Arrange
        const buf = new TraceBuffer(4);
        buf.push(1, 100, 0.9);
        buf.push(2, 200, 0.8);

        // Act
        const seen: Array<[number, number, number]> = [];
        buf.forEach((ts, hz, c) => seen.push([ts, hz, c]));

        // Assert
        expect(buf.size).toBe(2);
        // Float32Array quantises confidence; tsMs is Float64 and exact.
        expect(seen).toEqual([
            [1, 100, Math.fround(0.9)],
            [2, 200, Math.fround(0.8)],
        ]);
    });

    it('overwrites oldest samples when capacity is exceeded and iterates oldest-to-newest', () => {
        // Arrange
        const buf = new TraceBuffer(3);
        for (let i = 1; i <= 5; i += 1) {
            buf.push(i, i * 10, i / 10);
        }

        // Act
        const timestamps: number[] = [];
        buf.forEach((ts) => timestamps.push(ts));

        // Assert
        expect(buf.size).toBe(3);
        expect(timestamps).toEqual([3, 4, 5]);
    });

    it('forEach is a no-op on empty buffers', () => {
        // Arrange
        const buf = new TraceBuffer(2);
        let calls = 0;

        // Act
        buf.forEach(() => {
            calls += 1;
        });

        // Assert
        expect(calls).toBe(0);
    });

    it('throws on non-positive or non-integer capacity', () => {
        // Arrange / Act / Assert
        expect(() => new TraceBuffer(0)).toThrow();
        expect(() => new TraceBuffer(-1)).toThrow();
        expect(() => new TraceBuffer(1.5)).toThrow();
    });
});
