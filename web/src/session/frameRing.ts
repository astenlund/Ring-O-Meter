// SAB-backed lock-free ring buffer shared between the audio worklet
// (writer) and the main + plot-worker threads (readers). SoA layout
// in a single SharedArrayBuffer keeps the JS side simple: one SAB
// passes across boundaries, each thread reconstructs typed-array
// views at the agreed byte offsets. See
// .claude/specs/2026-04-22-sab-frame-ring.md for the full design.

// Slot count. Power of 2 so slot = writeIdx & (CAPACITY - 1).
// 1024 slots at ~47 Hz per channel = ~21.8 s of history, ~2.2x the
// 10 s plot window — gives ample headroom over consumer lag and
// ensures the skip-oldest tearing convention bites only if a reader
// stalls mid-forEach by >21 ms (see tearing section of spec).
export const CAPACITY = 1024;
const CAP_MASK = CAPACITY - 1;

// Byte layout inside one ring's SAB. Int32 header first (natural
// alignment for Atomics), then 8-byte-aligned Float64 for
// captureContextMs, then two Float32 columns.
const HEADER_OFFSET = 0;
const HEADER_BYTES = 8;  // 4 bytes header + 4 bytes pad for Float64 alignment
const CTX_MS_OFFSET = HEADER_BYTES;
const CTX_MS_BYTES = CAPACITY * 8;
const HZ_OFFSET = CTX_MS_OFFSET + CTX_MS_BYTES;
const HZ_BYTES = CAPACITY * 4;
const CONF_OFFSET = HZ_OFFSET + HZ_BYTES;
const CONF_BYTES = CAPACITY * 4;
export const RING_SAB_BYTES = CONF_OFFSET + CONF_BYTES;  // 8 + 16 * CAPACITY = 16392

export interface UiFrame {
    fundamentalHz: number;
    confidence: number;
}

/**
 * Allocate a fresh SharedArrayBuffer sized for one ring. Called on
 * the main thread at channel creation; the same SAB reference flows
 * to the worklet (via processorOptions) and to the plot worker (via
 * AttachChannelMessage). Cheap: just a sized-buffer allocation.
 */
export function createFrameRing(): SharedArrayBuffer {
    return new SharedArrayBuffer(RING_SAB_BYTES);
}

// Shape the three typed-array views a ring user needs. Factored so
// writer and reader construct identical views from the same
// constants, with no drift risk.
interface RingViews {
    header: Int32Array;
    contextMs: Float64Array;
    hz: Float32Array;
    conf: Float32Array;
}

function viewsOver(sab: SharedArrayBuffer): RingViews {
    return {
        header: new Int32Array(sab, HEADER_OFFSET, 1),
        contextMs: new Float64Array(sab, CTX_MS_OFFSET, CAPACITY),
        hz: new Float32Array(sab, HZ_OFFSET, CAPACITY),
        conf: new Float32Array(sab, CONF_OFFSET, CAPACITY),
    };
}

/**
 * Writer side of the ring. One instance per channel, lives in the
 * AudioWorkletProcessor. Not thread-safe for multiple writers; by
 * construction there is only ever one per ring.
 */
export class FrameRingWriter {
    private readonly header: Int32Array;
    private readonly contextMs: Float64Array;
    private readonly hz: Float32Array;
    private readonly conf: Float32Array;
    // Monotonic, per-instance. Not atomic itself — only the publish
    // via Atomics.store on this.header is observable externally.
    private writeIdx = 0;

    public constructor(sab: SharedArrayBuffer) {
        const views = viewsOver(sab);
        this.header = views.header;
        this.contextMs = views.contextMs;
        this.hz = views.hz;
        this.conf = views.conf;
    }

    /**
     * Publish a new frame. Writes all three field slots first, then
     * Atomics.store on the header as the "commit" signal. JS
     * Atomics.store is sequentially consistent: any consumer that
     * sees the new writeIdx via Atomics.load is guaranteed to see
     * the preceding field writes. Zero allocations per call.
     */
    public publish(captureContextMs: number, fundamentalHz: number, confidence: number): void {
        const slot = this.writeIdx & CAP_MASK;
        this.contextMs[slot] = captureContextMs;
        this.hz[slot] = fundamentalHz;
        this.conf[slot] = confidence;
        this.writeIdx += 1;
        Atomics.store(this.header, 0, this.writeIdx);
    }
}

/**
 * Reader side of the ring. Two instances per channel typically: one
 * on main (for useFrameState's NoteReadout pull) and one in the plot
 * worker (for paint iteration). Stateless apart from the
 * reconciliation offset, which can be updated in place via
 * setOffset to handle AudioContext suspend/resume.
 */
export class FrameRingReader {
    public readonly sab: SharedArrayBuffer;
    public readonly capacity = CAPACITY;
    private readonly header: Int32Array;
    private readonly contextMs: Float64Array;
    private readonly hz: Float32Array;
    private readonly conf: Float32Array;
    // Main's performance.now() at the moment audioContext.currentTime
    // was 0 (or equivalently, the constant difference between the two
    // clocks while the context is running). Readers add this to
    // slot.contextMs to produce a tsMs in main's paint epoch.
    private offsetMs: number;

    public constructor(sab: SharedArrayBuffer, perfNowAtContextTimeZero: number) {
        this.sab = sab;
        this.offsetMs = perfNowAtContextTimeZero;
        const views = viewsOver(sab);
        this.header = views.header;
        this.contextMs = views.contextMs;
        this.hz = views.hz;
        this.conf = views.conf;
    }

    /** Current write index (monotonic, unbounded modulo Int32 wrap). */
    public published(): number {
        return Atomics.load(this.header, 0);
    }

    /** Update the epoch offset after an AudioContext suspend/resume. */
    public setOffset(perfNowAtContextTimeZero: number): void {
        this.offsetMs = perfNowAtContextTimeZero;
    }

    /**
     * Main-side pull. Returns the newest published frame's UI shape,
     * or null if no frames have been published yet. Allocates one
     * UiFrame per call — called at ~15 Hz max from useFrameState's
     * rAF flush, so ~60 allocations/s across 4 channels.
     */
    public readLatest(): UiFrame | null {
        const pub = Atomics.load(this.header, 0);
        if (pub === 0) {
            return null;
        }
        const slot = (pub - 1) & CAP_MASK;

        return {fundamentalHz: this.hz[slot], confidence: this.conf[slot]};
    }

    /**
     * Worker-side window-bounded iteration. Backward-scans from the
     * newest slot to find the oldest in-window sample (plus one
     * pre-window sample for drawTraces's left-edge interpolation),
     * then forward-iterates invoking cb on each. Zero per-slot
     * allocation; the callback itself is allocated by the caller
     * once per voice per paint (same shape as today's
     * TraceBuffer.forEach — JIT closure hoisting keeps it zero-alloc
     * in steady state, proven by paintLoop.alloc.browser.ts).
     *
     * The tsMs passed to cb is in the paint epoch (contextMs +
     * offsetMs), so drawTraces' rolling-window math works unchanged.
     */
    public forEach(
        startMs: number,
        cb: (tsMs: number, fundamentalHz: number, confidence: number) => void,
    ): void {
        const pub = Atomics.load(this.header, 0);
        if (pub === 0) {
            return;
        }
        const absoluteOldest = Math.max(0, pub - (CAPACITY - 1));

        // Backward scan: stop as soon as a sample falls below
        // startMs. The stopped-on sample is retained as the "leading
        // pre-window" value drawTraces interpolates to the left edge.
        let first = absoluteOldest;
        for (let i = pub - 1; i >= absoluteOldest; i -= 1) {
            const slot = i & CAP_MASK;
            const tsMs = this.contextMs[slot] + this.offsetMs;
            if (tsMs < startMs) {
                first = i;
                break;
            }
        }

        for (let i = first; i < pub; i += 1) {
            const slot = i & CAP_MASK;
            cb(this.contextMs[slot] + this.offsetMs, this.hz[slot], this.conf[slot]);
        }
    }
}
