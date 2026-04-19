// Fixed-capacity ring buffer for rolling pitch traces. Stores samples in
// struct-of-arrays form (one typed array per field) so pushes are O(1) with
// no per-sample object allocation and drawTraces can iterate without
// boxing/unboxing each sample. When full, the oldest sample is overwritten
// on the next push, which naturally caps memory at the window size without
// needing per-frame trims.
//
// Lives under web/src/session/ because it holds per-channel frame state,
// not UI. UI (canvas paint) only reads from it. Slice 1's useFrameState
// hook will be the next tenant of this directory.
export class TraceBuffer {
    public readonly capacity: number;
    private readonly tsMsArr: Float64Array;
    private readonly fundamentalHzArr: Float32Array;
    private readonly confidenceArr: Float32Array;
    private head = 0;
    private filled = 0;

    public constructor(capacity: number) {
        if (!(capacity > 0) || !Number.isInteger(capacity)) {
            throw new Error('TraceBuffer: capacity must be a positive integer');
        }
        this.capacity = capacity;
        this.tsMsArr = new Float64Array(capacity);
        this.fundamentalHzArr = new Float32Array(capacity);
        this.confidenceArr = new Float32Array(capacity);
    }

    public get size(): number {
        return this.filled;
    }

    public push(tsMs: number, fundamentalHz: number, confidence: number): void {
        this.tsMsArr[this.head] = tsMs;
        this.fundamentalHzArr[this.head] = fundamentalHz;
        this.confidenceArr[this.head] = confidence;
        this.head = (this.head + 1) % this.capacity;
        if (this.filled < this.capacity) {
            this.filled += 1;
        }
    }

    // Iterates samples oldest-to-newest. The caller's callback is allocated
    // once per forEach call (not per sample). When the buffer has wrapped,
    // iteration runs as two contiguous spans instead of taking a modulo per
    // sample.
    public forEach(fn: (tsMs: number, fundamentalHz: number, confidence: number) => void): void {
        if (this.filled === 0) {
            return;
        }
        if (this.filled < this.capacity) {
            for (let i = 0; i < this.filled; i += 1) {
                fn(this.tsMsArr[i], this.fundamentalHzArr[i], this.confidenceArr[i]);
            }

            return;
        }
        for (let i = this.head; i < this.capacity; i += 1) {
            fn(this.tsMsArr[i], this.fundamentalHzArr[i], this.confidenceArr[i]);
        }
        for (let i = 0; i < this.head; i += 1) {
            fn(this.tsMsArr[i], this.fundamentalHzArr[i], this.confidenceArr[i]);
        }
    }
}
