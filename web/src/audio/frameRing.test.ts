import {describe, expect, it} from 'vitest';
import {
    CAPACITY,
    FrameRingReader,
    FrameRingWriter,
    RING_SAB_BYTES,
    createFrameRing,
} from './frameRing';

const OFFSET_MS = 10_000;  // arbitrary; readers just add it to contextMs

function writer(sab: SharedArrayBuffer): FrameRingWriter {
    return new FrameRingWriter(sab);
}

function reader(sab: SharedArrayBuffer, offset = OFFSET_MS): FrameRingReader {
    return new FrameRingReader(sab, offset);
}

describe('createFrameRing', () => {
    it('produces a SharedArrayBuffer of the documented size', () => {
        const sab = createFrameRing();
        expect(sab).toBeInstanceOf(SharedArrayBuffer);
        expect(sab.byteLength).toBe(RING_SAB_BYTES);
        // 8 header + 16 bytes per slot * 1024 slots
        expect(RING_SAB_BYTES).toBe(8 + 16 * CAPACITY);
    });
});

describe('FrameRingReader.readLatest', () => {
    it('returns null before any frame is published', () => {
        const sab = createFrameRing();
        const r = reader(sab);
        expect(r.readLatest()).toBeNull();
    });

    it('returns the most recently published frame', () => {
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab);
        w.publish(100, 220, 0.9);
        w.publish(101, 330, 0.85);
        w.publish(102, 440, 0.95);
        const latest = r.readLatest();
        expect(latest).toEqual({fundamentalHz: 440, confidence: expect.closeTo(0.95, 5)});
    });

    it('does not include contextMs or offset — UI shape is narrow', () => {
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab, 999);
        w.publish(50, 220, 0.9);
        const latest = r.readLatest()!;
        // No tsMs field; offset does not leak through readLatest.
        expect(Object.keys(latest).sort()).toEqual(['confidence', 'fundamentalHz']);
    });
});

describe('FrameRingReader.published', () => {
    it('returns 0 before any publish', () => {
        const sab = createFrameRing();
        const r = reader(sab);
        expect(r.published()).toBe(0);
    });

    it('increments monotonically with publishes', () => {
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab);
        w.publish(0, 200, 0.5);
        expect(r.published()).toBe(1);
        w.publish(0, 200, 0.5);
        w.publish(0, 200, 0.5);
        expect(r.published()).toBe(3);
    });
});

describe('FrameRingReader.forEach', () => {
    it('emits nothing before any publish', () => {
        const sab = createFrameRing();
        const r = reader(sab);
        const samples: number[] = [];
        r.forEach(0, (tsMs) => samples.push(tsMs));
        expect(samples).toEqual([]);
    });

    it('emits all in-window samples with tsMs in paint basis', () => {
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab, OFFSET_MS);
        // contextMs values 100, 200, 300
        w.publish(100, 220, 0.9);
        w.publish(200, 330, 0.85);
        w.publish(300, 440, 0.95);
        const samples: Array<[number, number, number]> = [];
        r.forEach(0, (tsMs, hz, conf) => samples.push([tsMs, hz, conf]));
        // tsMs = contextMs + OFFSET_MS
        expect(samples).toHaveLength(3);
        expect(samples[0][0]).toBe(100 + OFFSET_MS);
        expect(samples[1][0]).toBe(200 + OFFSET_MS);
        expect(samples[2][0]).toBe(300 + OFFSET_MS);
        expect(samples[2][1]).toBe(440);
    });

    it('emits one pre-window sample plus in-window when startMs cuts the data', () => {
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab, OFFSET_MS);
        // Publishing with contextMs 100, 200, 300, 400
        w.publish(100, 220, 0.9);
        w.publish(200, 330, 0.85);
        w.publish(300, 440, 0.95);
        w.publish(400, 550, 0.92);
        // Paint window starts at tsMs = 10_250, so contextMs 200 is
        // the leading pre-window sample, 300 and 400 are in-window.
        const samples: number[] = [];
        r.forEach(OFFSET_MS + 250, (tsMs) => samples.push(tsMs));
        // Expected: leading pre-window (contextMs 200 => 10_200) +
        // in-window (10_300, 10_400).
        expect(samples).toEqual([OFFSET_MS + 200, OFFSET_MS + 300, OFFSET_MS + 400]);
    });

    it('reflects a setOffset update for subsequent forEach calls', () => {
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab, OFFSET_MS);
        w.publish(100, 220, 0.9);
        const before: number[] = [];
        r.forEach(0, (tsMs) => before.push(tsMs));
        expect(before[0]).toBe(OFFSET_MS + 100);
        r.setOffset(OFFSET_MS + 500);
        const after: number[] = [];
        r.forEach(0, (tsMs) => after.push(tsMs));
        expect(after[0]).toBe(OFFSET_MS + 500 + 100);
    });

    it('skips the writer\'s next-write slot when the ring has wrapped', () => {
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab, 0);
        // Publish 2 * CAPACITY frames so the ring has fully wrapped.
        for (let i = 0; i < 2 * CAPACITY; i += 1) {
            w.publish(i, 100 + i, 0.5);
        }
        // After 2*C publishes, writeIdx = 2*C; next write target slot
        // = 2*C & (C-1) = 0. Reader should iterate slots 1..1023,
        // never slot 0, which now holds stale data the writer is
        // about to overwrite on next publish.
        let seenSlotZeroData = false;
        r.forEach(0, (_, hz) => {
            // Slot 0's current value is contextMs * 100 from the
            // last write to that slot before we stopped. After the
            // 2*C publishes loop above, slot 0 holds publish index
            // 2*C - CAPACITY = CAPACITY (hz = 100 + 1024 = 1124).
            if (hz === 1124) {
                seenSlotZeroData = true;
            }
        });
        expect(seenSlotZeroData).toBe(false);
    });
});
