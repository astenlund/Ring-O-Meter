import {describe, expect, it} from 'vitest';
import {drawTraces, type PaintFrame, type RingsRecord, type VoiceEntry} from '../plot/paint';
import {createFrameRing, FrameRingReader, FrameRingWriter} from '../session/frameRing';

// Minimal stub of CanvasRenderingContext2D that records only the path
// operations drawTraces invokes. Cast to the full type at the boundary so
// the tests touch nothing beyond the draw API under test.
interface PathOp {
    op: 'beginPath' | 'moveTo' | 'lineTo' | 'stroke';
    x?: number;
    y?: number;
}

function makeRecorder() {
    const ops: PathOp[] = [];
    const ctx = {
        strokeStyle: '',
        lineWidth: 0,
        beginPath: () => {
            ops.push({op: 'beginPath'});
        },
        moveTo: (x: number, y: number) => {
            ops.push({op: 'moveTo', x, y});
        },
        lineTo: (x: number, y: number) => {
            ops.push({op: 'lineTo', x, y});
        },
        stroke: () => {
            ops.push({op: 'stroke'});
        },
    };

    return {ctx: ctx as unknown as CanvasRenderingContext2D, ops};
}

const WINDOW_MS = 100;
const WIDTH = 100;
const NOW_MS = 1100;
// startMs = nowMs - windowMs = 1000. x = (tsMs - 1000), so tsMs-to-x is 1:1.
// hzToY is identity so y-assertions can name hz values directly.
function makeFrame(ctx: CanvasRenderingContext2D): PaintFrame {
    return {
        ctx,
        size: {width: WIDTH, height: 360},
        hzToY: (hz) => hz,
        nowMs: NOW_MS,
        windowMs: WINDOW_MS,
    };
}

const voices: ReadonlyArray<VoiceEntry> = [{channelId: 'v1', label: 'V1', color: '#fff'}];

// Builds a RingsRecord with a single channel 'v1' populated by writing
// the sample triples into a fresh SAB via FrameRingWriter. Reader
// offset is 0 so sample tsMs values pass through unchanged, letting
// the test name absolute ts values in the (tsMs - startMs) math below.
function singleRing(samples: ReadonlyArray<readonly [number, number, number]>): RingsRecord {
    const sab = createFrameRing();
    const writer = new FrameRingWriter(sab);
    for (const [ts, hz, conf] of samples) {
        writer.publish(ts, hz, conf);
    }

    return {v1: {reader: new FrameRingReader(sab, 0)}};
}

describe('drawTraces', () => {
    it('draws a single voice with moveTo then lineTo for an all-in-window run', () => {
        // Arrange
        const {ctx, ops} = makeRecorder();
        const rings = singleRing([
            [1010, 300, 0.9],
            [1050, 400, 0.9],
        ]);

        // Act
        drawTraces(makeFrame(ctx), voices, rings);

        // Assert
        expect(ops).toEqual([
            {op: 'beginPath'},
            {op: 'moveTo', x: 10, y: 300},
            {op: 'lineTo', x: 50, y: 400},
            {op: 'stroke'},
        ]);
    });

    it('interpolates a moveTo at x=0 when a pre-window sample precedes the first in-window sample', () => {
        // Arrange
        // prev at ts=900 (pre-window, startMs=1000), hz=200.
        // cur  at ts=1100 (in-window), hz=400.
        // t = (1000 - 900) / (1100 - 900) = 0.5; yInterp = 200 + (400-200)*0.5 = 300.
        // cur x = (1100 - 1000) = 100.
        const {ctx, ops} = makeRecorder();
        const rings = singleRing([
            [900, 200, 0.9],
            [1100, 400, 0.9],
        ]);

        // Act
        drawTraces(makeFrame(ctx), voices, rings);

        // Assert
        expect(ops).toEqual([
            {op: 'beginPath'},
            {op: 'moveTo', x: 0, y: 300},
            {op: 'lineTo', x: 100, y: 400},
            {op: 'stroke'},
        ]);
    });

    it('breaks the trace on a mid-window confidence drop and does not carry stale pre-window state', () => {
        // Arrange
        // Low-confidence mid-window sample must clear prevPreWindow so the
        // next in-window sample does NOT interpolate from the pre-window one.
        const {ctx, ops} = makeRecorder();
        const rings = singleRing([
            [900, 200, 0.9],  // pre-window, displayable (sets prevPreWindow)
            [1020, 999, 0.1], // in-window but gate fails (clears prevPreWindow)
            [1050, 400, 0.9], // in-window, displayable; must be a plain moveTo
        ]);

        // Act
        drawTraces(makeFrame(ctx), voices, rings);

        // Assert
        expect(ops).toEqual([
            {op: 'beginPath'},
            {op: 'moveTo', x: 50, y: 400},
            {op: 'stroke'},
        ]);
    });

    it('draws nothing when every sample is pre-window', () => {
        // Arrange
        const {ctx, ops} = makeRecorder();
        const rings = singleRing([
            [800, 200, 0.9],
            [900, 250, 0.9],
        ]);

        // Act
        drawTraces(makeFrame(ctx), voices, rings);

        // Assert
        // Reader emits only the latest pre-window sample as the leading
        // interpolation handoff; drawTraces's pen stays false because
        // there is no in-window sample to draw to, so the inner branch
        // is never taken and only the beginPath / stroke pair lands.
        expect(ops).toEqual([{op: 'beginPath'}, {op: 'stroke'}]);
    });

    it('tolerates a voice with no matching ring and keeps drawing remaining voices', () => {
        // Arrange
        // Simulates channelId drift during device reselection: v2 exists in
        // the roster but has no ring entry yet. drawTraces must not throw
        // and must still emit the path boundary calls for v2.
        const {ctx, ops} = makeRecorder();
        const twoVoices: ReadonlyArray<VoiceEntry> = [
            {channelId: 'v1', label: 'V1', color: '#fff'},
            {channelId: 'v2', label: 'V2', color: '#ccc'},
        ];
        const rings = singleRing([[1020, 300, 0.9]]);

        // Act
        drawTraces(makeFrame(ctx), twoVoices, rings);

        // Assert
        expect(ops).toEqual([
            {op: 'beginPath'},
            {op: 'moveTo', x: 20, y: 300},
            {op: 'stroke'},
            {op: 'beginPath'},
            {op: 'stroke'},
        ]);
    });

    it('breaks cleanly when the first in-window sample fails the display gate', () => {
        // Arrange
        // Covers the branch where pen is false AND prevPreWindow is false
        // at the first in-window encounter because that sample is undisplayable.
        const {ctx, ops} = makeRecorder();
        const rings = singleRing([
            [1010, 300, 0.1], // in-window, gate fails
            [1050, 400, 0.9], // in-window, first displayable
        ]);

        // Act
        drawTraces(makeFrame(ctx), voices, rings);

        // Assert
        expect(ops).toEqual([
            {op: 'beginPath'},
            {op: 'moveTo', x: 50, y: 400},
            {op: 'stroke'},
        ]);
    });
});
