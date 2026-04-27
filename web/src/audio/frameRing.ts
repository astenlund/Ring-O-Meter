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
// captureContextMs, then four Float32 columns. The trailing two
// (rmsDb, hzRaw) are written by the worklet but not yet surfaced by
// the FrameRingReader API; they will gain reader-side accessors when
// the first reader-side consumer lands. Slice 1's SignalR publish
// sink is the proximate driver (it forwards every column on the
// wire, where AnalysisFrame already carries them at [Key(4)]/[Key(5)]);
// downstream analytical consumers include vowel-matching mic
// calibration, chop-cop amplitude envelope, and heuristic-introspection
// raw-YIN audit. RMS_DB_OFFSET and HZ_RAW_OFFSET are exported so
// frameRing.test.ts can read these columns directly via raw typed
// views until that reader API lands.
const HEADER_OFFSET = 0;
const HEADER_BYTES = 8;  // 4 bytes header + 4 bytes pad for Float64 alignment
const CTX_MS_OFFSET = HEADER_BYTES;
const CTX_MS_BYTES = CAPACITY * 8;
const HZ_OFFSET = CTX_MS_OFFSET + CTX_MS_BYTES;
const HZ_BYTES = CAPACITY * 4;
const CONF_OFFSET = HZ_OFFSET + HZ_BYTES;
const CONF_BYTES = CAPACITY * 4;
export const RMS_DB_OFFSET = CONF_OFFSET + CONF_BYTES;
const RMS_DB_BYTES = CAPACITY * 4;
export const HZ_RAW_OFFSET = RMS_DB_OFFSET + RMS_DB_BYTES;
const HZ_RAW_BYTES = CAPACITY * 4;
// Layout-drift tripwire: any column add/remove/resize updates this
// total. createFrameRing's size-invariant test pins 8 + 24 * CAPACITY
// = 24584; the trailing-column offset test then catches column
// reordering at finer grain.
export const RING_SAB_BYTES = HZ_RAW_OFFSET + HZ_RAW_BYTES;

export interface UiFrame {
    fundamentalHz: number;
    confidence: number;
}

/**
 * Cross-thread descriptor for a per-channel frame ring. Bundles the
 * SAB (the data source) with the epoch offset (the perf-vs-context
 * clock alignment) so the two ride together across the boundary hops
 * between VoiceChannel, App, PlotController, the plot-worker message,
 * and the worker-side FrameRingReader. epochOffsetMs is main's
 * performance.now() at the moment audioContext.currentTime was 0
 * (equivalently, the constant difference between the two clocks while
 * the context is running); add it to a slot's contextMs to get a tsMs
 * in main's paint epoch.
 */
export interface FrameSource {
    sab: SharedArrayBuffer;
    epochOffsetMs: number;
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

// Shape the typed-array views a ring user needs. Factored so writer
// and reader construct identical views from the same constants, with
// no drift risk. Header + five data columns.
interface RingViews {
    header: Int32Array;
    contextMs: Float64Array;
    hz: Float32Array;
    conf: Float32Array;
    rmsDb: Float32Array;
    hzRaw: Float32Array;
}

function viewsOver(sab: SharedArrayBuffer): RingViews {
    return {
        header: new Int32Array(sab, HEADER_OFFSET, 1),
        contextMs: new Float64Array(sab, CTX_MS_OFFSET, CAPACITY),
        hz: new Float32Array(sab, HZ_OFFSET, CAPACITY),
        conf: new Float32Array(sab, CONF_OFFSET, CAPACITY),
        rmsDb: new Float32Array(sab, RMS_DB_OFFSET, CAPACITY),
        hzRaw: new Float32Array(sab, HZ_RAW_OFFSET, CAPACITY),
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
    private readonly rmsDb: Float32Array;
    private readonly hzRaw: Float32Array;
    // Monotonic, per-instance. Not atomic itself — only the publish
    // via Atomics.store on this.header is observable externally.
    private writeIdx = 0;

    public constructor(sab: SharedArrayBuffer) {
        const views = viewsOver(sab);
        this.header = views.header;
        this.contextMs = views.contextMs;
        this.hz = views.hz;
        this.conf = views.conf;
        this.rmsDb = views.rmsDb;
        this.hzRaw = views.hzRaw;
    }

    /**
     * Publish a new frame. Writes all five field slots first, then
     * Atomics.store on the header as the "commit" signal. JS
     * Atomics.store is sequentially consistent: any consumer that
     * sees the new writeIdx via Atomics.load is guaranteed to see
     * the preceding field writes. Zero allocations per call.
     */
    public publish(
        captureContextMs: number,
        fundamentalHz: number,
        confidence: number,
        rmsDb: number,
        fundamentalHzRaw: number,
    ): void {
        const slot = this.writeIdx & CAP_MASK;
        this.contextMs[slot] = captureContextMs;
        this.hz[slot] = fundamentalHz;
        this.conf[slot] = confidence;
        this.rmsDb[slot] = rmsDb;
        this.hzRaw[slot] = fundamentalHzRaw;
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
 *
 * Reader is intentionally opaque: it does NOT expose the backing SAB.
 * Callers that need to forward the ring across a thread boundary
 * (today: PlotController -> plot worker) thread the FrameSource
 * descriptor alongside the reader, not through it. This keeps the
 * reader interface implementable by future non-SAB-backed readers
 * (e.g., slice 1's SignalR DisplayClient).
 */
export class FrameRingReader {
    private readonly header: Int32Array;
    private readonly contextMs: Float64Array;
    private readonly hz: Float32Array;
    private readonly conf: Float32Array;
    private epochOffsetMs: number;

    public constructor(sab: SharedArrayBuffer, epochOffsetMs: number) {
        this.epochOffsetMs = epochOffsetMs;
        const views = viewsOver(sab);
        this.header = views.header;
        this.contextMs = views.contextMs;
        this.hz = views.hz;
        this.conf = views.conf;
        // viewsOver also returns rmsDb/hzRaw; bind them here when a
        // reader-side consumer lands (see top-of-file comment).
    }

    /** Current write index (monotonic, unbounded modulo Int32 wrap). */
    public published(): number {
        return Atomics.load(this.header, 0);
    }

    /** Update the epoch offset after an AudioContext suspend/resume. */
    public setOffset(epochOffsetMs: number): void {
        this.epochOffsetMs = epochOffsetMs;
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
     * once per voice per paint — JIT closure hoisting keeps it
     * zero-alloc in steady state, proven by
     * paintLoop.alloc.browser.ts.
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
            const tsMs = this.contextMs[slot] + this.epochOffsetMs;
            if (tsMs < startMs) {
                first = i;
                break;
            }
        }

        for (let i = first; i < pub; i += 1) {
            const slot = i & CAP_MASK;
            cb(this.contextMs[slot] + this.epochOffsetMs, this.hz[slot], this.conf[slot]);
        }
    }
}
