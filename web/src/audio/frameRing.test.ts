import {describe, expect, it} from 'vitest';
import {
    CAPACITY,
    FrameRingReader,
    FrameRingWriter,
    HZ_RAW_OFFSET,
    RING_SAB_BYTES,
    RMS_DB_OFFSET,
    type FormantFrame,
    type PublishFrame,
    type UiFrame,
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
        // 8-byte header + 8-byte contextMs Float64 + four 4-byte Float32 columns
        // (hz, conf, rmsDb, hzRaw) + four new 4-byte Float32 columns (f1Hz, f2Hz,
        // f3Hz, f4Hz) per slot = 40 bytes per slot.
        expect(RING_SAB_BYTES).toBe(8 + 40 * CAPACITY);
    });
});

describe('FrameRingReader.readLatest', () => {
    it('returns false before any frame is published', () => {
        // Arrange
        const sab = createFrameRing();
        const r = reader(sab);
        const out: UiFrame = {fundamentalHz: 0, confidence: 0};

        // Act / Assert
        expect(r.readLatest(out)).toBe(false);
    });

    it('writes the most recently published frame into out and returns true', () => {
        // Arrange
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab);
        w.publish({captureContextMs: 100, fundamentalHz: 220, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 220, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        w.publish({captureContextMs: 101, fundamentalHz: 330, confidence: 0.85, rmsDb: -30, fundamentalHzRaw: 330, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        w.publish({captureContextMs: 102, fundamentalHz: 440, confidence: 0.95, rmsDb: -30, fundamentalHzRaw: 440, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        const out: UiFrame = {fundamentalHz: 0, confidence: 0};

        // Act
        const result = r.readLatest(out);

        // Assert
        expect(result).toBe(true);
        expect(out.fundamentalHz).toBe(440);
        expect(out.confidence).toBeCloseTo(0.95, 5);
    });

    it('does not include contextMs or offset (UI shape is narrow)', () => {
        // Arrange
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab, 999);
        w.publish({captureContextMs: 50, fundamentalHz: 220, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 220, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        const out: UiFrame = {fundamentalHz: 0, confidence: 0};

        // Act
        r.readLatest(out);

        // Assert: no tsMs field; offset does not leak through readLatest.
        // rmsDb and fundamentalHzRaw are NOT part of UiFrame (the narrow
        // pitch-only shape); rmsDb is exposed via readLatestFormants
        // instead (see the FormantFrame round-trip test below).
        // fundamentalHzRaw has no reader-side accessor yet (hzRaw column
        // is written but unbound in the FrameRingReader constructor).
        expect(Object.keys(out).sort()).toEqual(['confidence', 'fundamentalHz']);
    });

    it('leaves out unmodified when no frame is published', () => {
        // Arrange
        const sab = createFrameRing();
        const r = reader(sab);
        const out: UiFrame = {fundamentalHz: 99, confidence: 0.42};

        // Act / Assert: sentinels preserved exactly; pins the contract
        // so a future implementation that nulls fields on miss fails here.
        expect(r.readLatest(out)).toBe(false);
        expect(out.fundamentalHz).toBe(99);
        expect(out.confidence).toBe(0.42);
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
        w.publish({captureContextMs: 0, fundamentalHz: 200, confidence: 0.5, rmsDb: -30, fundamentalHzRaw: 200, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        expect(r.published()).toBe(1);
        w.publish({captureContextMs: 0, fundamentalHz: 200, confidence: 0.5, rmsDb: -30, fundamentalHzRaw: 200, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        w.publish({captureContextMs: 0, fundamentalHz: 200, confidence: 0.5, rmsDb: -30, fundamentalHzRaw: 200, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
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
        w.publish({captureContextMs: 100, fundamentalHz: 220, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 220, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        w.publish({captureContextMs: 200, fundamentalHz: 330, confidence: 0.85, rmsDb: -30, fundamentalHzRaw: 330, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        w.publish({captureContextMs: 300, fundamentalHz: 440, confidence: 0.95, rmsDb: -30, fundamentalHzRaw: 440, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
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
        w.publish({captureContextMs: 100, fundamentalHz: 220, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 220, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        w.publish({captureContextMs: 200, fundamentalHz: 330, confidence: 0.85, rmsDb: -30, fundamentalHzRaw: 330, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        w.publish({captureContextMs: 300, fundamentalHz: 440, confidence: 0.95, rmsDb: -30, fundamentalHzRaw: 440, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
        w.publish({captureContextMs: 400, fundamentalHz: 550, confidence: 0.92, rmsDb: -30, fundamentalHzRaw: 550, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
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
        w.publish({captureContextMs: 100, fundamentalHz: 220, confidence: 0.9, rmsDb: -30, fundamentalHzRaw: 220, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});
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
        // Hoisted scratch reused across the wrap-test loop; semantics of
        // the test are preserved (contextMs and hz vary per iteration),
        // and the literal-per-call alloc would be irrelevant here anyway
        // since this is a structural test, not an alloc test.
        const scratch: PublishFrame = {captureContextMs: 0, fundamentalHz: 0, confidence: 0.5, rmsDb: -30, fundamentalHzRaw: 0, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0};
        for (let i = 0; i < 2 * CAPACITY; i += 1) {
            scratch.captureContextMs = i;
            scratch.fundamentalHz = 100 + i;
            scratch.fundamentalHzRaw = 100 + i;
            w.publish(scratch);
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

describe('FrameRingWriter trailing-column writes', () => {
    it('lays rmsDb and fundamentalHzRaw bytes at the expected offsets', () => {
        const sab = createFrameRing();
        const w = writer(sab);
        // Distinct sentinel values so a swap of the two columns
        // would be observable. Guards against the writer's internal
        // column wiring in FrameRingWriter.publish (the surviving
        // failure mode); caller-side transposition that previously
        // could only be detected here is now a TypeScript error at
        // the publish call site.
        w.publish({captureContextMs: 100, fundamentalHz: 440, confidence: 0.9, rmsDb: -27.5, fundamentalHzRaw: 880, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0});

        const rmsDbView = new Float32Array(sab, RMS_DB_OFFSET, CAPACITY);
        const hzRawView = new Float32Array(sab, HZ_RAW_OFFSET, CAPACITY);
        // Float32 round-trip is exact for values representable in
        // single precision; -27.5 and 880 both are.
        expect(rmsDbView[0]).toBe(-27.5);
        expect(hzRawView[0]).toBe(880);
    });
});

describe('FrameRingReader.readLatestFormants', () => {
    it('round-trips formant columns through writer + readLatestFormants', () => {
        // Arrange
        const sab = createFrameRing();
        const w = writer(sab);
        const r = reader(sab, 0);
        const out: FormantFrame = {f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0, rmsDb: 0, fundamentalHz: 0, confidence: 0};

        // Act
        w.publish({
            captureContextMs: 100,
            fundamentalHz: 220,
            confidence: 0.9,
            rmsDb: -12,
            fundamentalHzRaw: 220,
            f1Hz: 500,
            f2Hz: 1500,
            f3Hz: 2500,
            f4Hz: 3500,
        });
        const ok = r.readLatestFormants(out);

        // Assert
        expect(ok).toBe(true);
        expect(out.f1Hz).toBe(500);
        expect(out.f2Hz).toBe(1500);
        expect(out.f3Hz).toBe(2500);
        expect(out.f4Hz).toBe(3500);
        expect(out.rmsDb).toBe(-12);
        expect(out.fundamentalHz).toBeCloseTo(220, 5);
        expect(out.confidence).toBeCloseTo(0.9, 5);
    });

    it('readLatestFormants returns false on never-published reader', () => {
        // Arrange
        const sab = createFrameRing();
        const r = reader(sab, 0);
        const out: FormantFrame = {f1Hz: 1, f2Hz: 2, f3Hz: 3, f4Hz: 4, rmsDb: 5, fundamentalHz: 6, confidence: 7};

        // Act
        const ok = r.readLatestFormants(out);

        // Assert: ok=false and out untouched (sentinel-preserving contract).
        expect(ok).toBe(false);
        expect(out.f1Hz).toBe(1);
        expect(out.f2Hz).toBe(2);
        expect(out.f3Hz).toBe(3);
        expect(out.f4Hz).toBe(4);
        expect(out.rmsDb).toBe(5);
        expect(out.fundamentalHz).toBe(6);
        expect(out.confidence).toBe(7);
    });
});
