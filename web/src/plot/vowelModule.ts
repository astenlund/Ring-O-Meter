// Shared logic for the vowel polygon visualization. Pure functions
// (no GPU, no canvas) so jsdom tests can import this module without
// pulling in WebGPU types. Both vowelModuleWebgpu.ts (worker-side
// WebGPU paint) and paint.ts's drawVowelPolygon (worker-side 2D
// paint) consume these helpers; keeping them in one module ensures
// the polygon ordering, metric, and dim-color computations stay
// identical across renderers.
//
// Per-voice state (gating debounce, last-known F1/F2 position, etc.)
// is held in a small state-machine class instantiated per attached
// channel. The main thread's lifecycle messages drive attach/detach;
// the worker holds one VoicePoint per attached channelId.

import {FORMANT_ABSENT_SENTINEL, type FormantFrame, type FrameRingReader} from '../audio/frameRing';
import {shouldDisplayFormants} from '../ui/displayGate';

// heuristic: vowel-gate-debounce-ms - smoothing window on gate
// transitions; sub-window flicker is suppressed. Lower = faster
// response (may flicker on consonant blips); higher = smoother but
// adds visible lag at the start of a sustained vowel.
export const GATE_DEBOUNCE_MS = 100;

// heuristic: vowel-order-debounce-ms - dwell time a proposed
// polygon ordering must be stable before replacing the
// currently-applied ordering. Suppresses edge-flicker when voices
// sit near collinear in F1/F2 space and tiny formant jitter swaps
// their polar-angle order frame-to-frame. 200 ms is below human
// reaction time but above typical formant jitter cadence.
export const ORDER_DEBOUNCE_MS = 200;

// heuristic: vowel-dim-brightness - factor multiplied into RGB when
// a voice's gate is failing. 0.5 keeps voice-color identity (the
// polygon vertex stays distinguishable per voice) while signaling
// "this voice is not contributing right now". Closer to 1.0 makes
// dim/full nearly indistinguishable; closer to 0 fades to near-black.
export const VOWEL_DIM_BRIGHTNESS = 0.5;

// Pre-allocated upper bound for ordering buffers; matches the
// variable-voice-count pattern's range (1-8 voices). Exported so the
// per-renderer paint modules can size their own pre-allocated scratch
// (vertex buffers, index buffers, dot staging) against the same upper
// bound; a local redeclaration would risk silent drift if the pattern
// ever extends to 5-12 voices for non-barbershop ensembles.
export const MAX_VOICES = 8;

// Adult-inclusive (both male and female) F1/F2 ranges, narrowly
// excluding child voices. Linear Hz on both axes; perceptual scales
// (Bark, mel, log-Hz) are an explicit anti-goal because they compress
// F2 where ring coaching needs amplification (see CLAUDE.md
// "Vowel-matching metric uses raw absolute Hz").
// Exported here (single source of truth) so both vowelModuleWebgpu.ts
// and plotWorker2dCanvas.ts import from one place; local copies in
// each renderer would risk silent axis-range drift.
// heuristic: vowel-axis-f1-min - lower bound on F1 axis. 100 (not
// 200) so close-front-rounded /y/ at ~250 Hz F1 has visible headroom
// from the top edge; the original 200 floor put /y/ ~5% from top
// (50 Hz of 900 Hz span), which read as "clipped" even though the dot
// was technically inside. Widening the axis 11% (900 -> 1000 Hz span)
// is a small compression cost in the populated region (most vowels
// sit F1 250-900) for visible margin on the tightest case.
export const F1_MIN = 100;
// heuristic: vowel-axis-f1-max - upper bound on F1 axis
export const F1_MAX = 1100;
// heuristic: vowel-axis-f2-min - lower bound on F2 axis
export const F2_MIN = 700;
// heuristic: vowel-axis-f2-max - upper bound on F2 axis
export const F2_MAX = 3300;
export const F1_SPAN = F1_MAX - F1_MIN;
export const F2_SPAN = F2_MAX - F2_MIN;

// heuristic: vowel-dot-css-size - dot side length in CSS pixels; both
// renderers compute device-pixel size as round(N * dpr). 4 reads as a
// crisp pixel marker at typical DPRs (4, 8, 10 device px); larger
// values feel "bubbly", smaller values disappear at high DPR. Single
// source of truth so the WebGPU and 2D renderers cannot drift.
export const VOWEL_DOT_CSS_SIZE = 4;

export interface VoicePoint {
    channelId: string;
    f1Hz: number;           // last-known F1 (held when gate fails)
    f2Hz: number;           // last-known F2 (held when gate fails)
    isDimmed: boolean;      // post-debounce gate state
    hasEverPublished: boolean; // false until the first formant frame arrives
}

// Sort voice points by polar angle around their centroid, writing the
// ordering as an index permutation into a caller-supplied Int32Array.
// Zero-alloc: the angles scratch is also caller-supplied so the
// per-renderer paint modules (vowelModuleWebgpu, 2D paint helpers) can
// reuse one Float64Array across frames. Insertion sort over an
// Int32Array stays alloc-free for any N <= MAX_VOICES; the cost is
// O(N^2) but the upper bound on N here makes that ~64 comparisons in
// the worst case, so the algorithmic choice is dominated by the
// allocation discipline. Stable tie-break on channelId for
// determinism in degenerate (collinear, identical-position) cases.
//
// `points` may have unused slots beyond `length` (e.g., a capacity-
// primed VoicePoint[] with .length=0 then partial push); only the
// first `length` entries are read.
export function polarAngleSortInto(
    points: ReadonlyArray<VoicePoint>,
    length: number,
    anglesScratch: Float64Array,
    outIndices: Int32Array,
): void {
    for (let i = 0; i < length; i++) {
        outIndices[i] = i;
    }
    if (length <= 2) {
        return;
    }
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < length; i++) {
        cx += points[i].f2Hz;
        cy += points[i].f1Hz;
    }
    cx /= length;
    cy /= length;
    for (let i = 0; i < length; i++) {
        const p = points[i];
        anglesScratch[i] = Math.atan2(p.f1Hz - cy, p.f2Hz - cx);
    }
    for (let i = 1; i < length; i++) {
        const key = outIndices[i];
        const angleKey = anglesScratch[key];
        const channelKey = points[key].channelId;
        let j = i - 1;
        while (j >= 0) {
            const cur = outIndices[j];
            const angleCur = anglesScratch[cur];
            // Strict-less-than at the angle level keeps tie-break
            // routing deterministic; ASCII string compare is alloc-free
            // on V8 and produces the same ordering as localeCompare
            // for GUID-shaped channelIds (the project's only producer).
            if (angleCur < angleKey) {
                break;
            }
            if (angleCur === angleKey && points[cur].channelId < channelKey) {
                break;
            }
            outIndices[j + 1] = outIndices[j];
            j--;
        }
        outIndices[j + 1] = key;
    }
}

// Allocating wrapper around polarAngleSortInto. Used by jsdom unit
// tests and any caller that does not own pre-allocated scratch
// buffers; the per-renderer paint modules call polarAngleSortInto
// directly to keep the hot path zero-alloc.
export function polarAngleSort(points: ReadonlyArray<VoicePoint>): number[] {
    const n = points.length;
    if (n === 0) {
        return [];
    }
    const angles = new Float64Array(n);
    const indices = new Int32Array(n);
    polarAngleSortInto(points, n, angles, indices);
    const result: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        result[i] = indices[i];
    }

    return result;
}

// Compute the polygon-area metric in Hz^2. For N >= 3, shoelace
// formula on the points in the supplied ordering. For N = 2, returns
// the squared edge length (the polygon degenerates to a single
// segment). For N = 0 or 1, returns NaN (no inter-voice spread).
//
// Currently consumed only by `vowelModule.test.ts`; the production
// paint paths build the polygon shape directly without computing the
// metric. Reserved for the future ring-score readout, mastery-history
// logging, and the Heuristic Introspection panel; do not delete as
// dead code.
//
// `ordering` is `ArrayLike<number>` (not `ReadonlyArray<number>`) so
// callers can pass either a `number[]` or a typed `Int32Array` view
// from a debounce buffer without a copy. Both shapes index identically;
// the wider type captures both.
export function polygonAreaMetric(
    points: ReadonlyArray<VoicePoint>,
    ordering: ArrayLike<number>,
): number {
    if (points.length < 2) {
        return Number.NaN;
    }
    if (points.length === 2) {
        const a = points[ordering[0]];
        const b = points[ordering[1]];
        const dx = a.f2Hz - b.f2Hz;
        const dy = a.f1Hz - b.f1Hz;

        return dx * dx + dy * dy;
    }
    let sum = 0;
    const n = ordering.length;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const pi = points[ordering[i]];
        const pj = points[ordering[j]];
        sum += pi.f2Hz * pj.f1Hz - pj.f2Hz * pi.f1Hz;
    }

    return Math.abs(sum) / 2;
}

// Per-voice gate-debounce state machine. Tracks "raw gate" (each
// frame's shouldDisplayFormants result) and emits a "smoothed gate"
// (current dim/full state) that only flips after GATE_DEBOUNCE_MS of
// consistent raw-gate readings.
export class GateDebounce {
    private currentDimmed = true; // start dimmed; first published frame flips off
    private rawSince = 0;         // ms since last raw-gate transition
    private lastRaw = false;

    public update(rawDisplay: boolean, dtMs: number): boolean {
        if (rawDisplay !== this.lastRaw) {
            // Count the current frame's dt toward the new state, not the
            // old one - the transition was detected at the end of this
            // frame, so this frame's elapsed time is part of the new
            // state's run-length. (rawSince = 0 here would lose dtMs
            // from the new run, which the unit test in this file
            // catches: a single update(true, GATE_DEBOUNCE_MS) call from
            // the initial dimmed state would not flip otherwise.)
            this.rawSince = dtMs;
            this.lastRaw = rawDisplay;
        }
        else {
            this.rawSince += dtMs;
        }
        if (this.rawSince >= GATE_DEBOUNCE_MS && this.currentDimmed === rawDisplay) {
            this.currentDimmed = !rawDisplay;
        }

        return this.currentDimmed;
    }

    public isDimmed(): boolean {
        return this.currentDimmed;
    }
}

// Polygon ordering debounce: keeps the applied ordering stable for
// `ORDER_DEBOUNCE_MS` after a proposed swap, preventing edge flicker
// when voices' polar angles cross near collinear configurations.
// Operates on Int32Array buffers pre-allocated for MAX_VOICES so the
// per-frame call is zero-alloc. Caller mutates `proposed` in place
// each frame (e.g., via polarAngleSort writing into a shared scratch
// buffer); update() compares the proposed contents to the currently-
// applied ordering and either copies a stable proposal into the
// applied buffer or holds the previous applied buffer until the
// proposal stabilizes.
export class OrderDebounce {
    private readonly applied = new Int32Array(MAX_VOICES);
    private readonly pending = new Int32Array(MAX_VOICES);
    private appliedLength = 0;
    private pendingLength = 0;
    private pendingMs = 0;

    public update(proposed: ArrayLike<number>, proposedLength: number, dtMs: number): void {
        if (this.appliedLength === 0) {
            // First call: accept proposed immediately, no debounce.
            this.copyInto(proposed, proposedLength, this.applied);
            this.appliedLength = proposedLength;

            return;
        }
        if (proposedLength === this.appliedLength && this.matches(proposed, this.applied, proposedLength)) {
            // Proposed matches applied; reset pending tracking.
            this.pendingLength = 0;
            this.pendingMs = 0;

            return;
        }
        if (proposedLength === this.pendingLength && this.matches(proposed, this.pending, proposedLength)) {
            this.pendingMs += dtMs;
            if (this.pendingMs >= ORDER_DEBOUNCE_MS) {
                this.copyInto(proposed, proposedLength, this.applied);
                this.appliedLength = proposedLength;
                this.pendingLength = 0;
                this.pendingMs = 0;
            }
        }
        else {
            this.copyInto(proposed, proposedLength, this.pending);
            this.pendingLength = proposedLength;
            this.pendingMs = dtMs;
        }
    }

    public getApplied(): Int32Array {
        return this.applied;
    }

    public getAppliedLength(): number {
        return this.appliedLength;
    }

    public reset(): void {
        this.appliedLength = 0;
        this.pendingLength = 0;
        this.pendingMs = 0;
    }

    private matches(a: ArrayLike<number>, b: ArrayLike<number>, len: number): boolean {
        for (let i = 0; i < len; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }

        return true;
    }

    private copyInto(src: ArrayLike<number>, len: number, dst: Int32Array): void {
        for (let i = 0; i < len; i++) {
            dst[i] = src[i];
        }
    }
}

// Read the latest formant frame from a SAB reader, apply the display
// gate, update the voice's visible state. Mutates `voice` in place.
// Returns true if the frame contained a valid formant position
// (f1 > 0 && f2 > 0) and the voice's f1Hz/f2Hz were updated; false
// otherwise (no published frame yet, or the published frame had a
// 0-sentinel formant slot meaning "no formant detected"). Gate flips
// are reflected in voice.isDimmed regardless of return value.
//
// The whole gate-relevant input (fundamentalHz, confidence, rmsDb)
// rides inside FormantFrame from a single coherent SAB slot read, so
// no second `readLatest` call is needed and the gate sees a frame's
// hz + rms together (not hz from one slot and rms from a possibly
// newer slot).
export function consumeLatestFrame(
    voice: VoicePoint,
    reader: FrameRingReader,
    formantsOut: FormantFrame,
    debounce: GateDebounce,
    dtMs: number,
): boolean {
    if (!reader.readLatestFormants(formantsOut)) {
        return false;
    }
    voice.hasEverPublished = true;
    const rawDisplay = shouldDisplayFormants(
        formantsOut.fundamentalHz,
        formantsOut.confidence,
        formantsOut.rmsDb,
    );
    voice.isDimmed = debounce.update(rawDisplay, dtMs);
    // FORMANT_ABSENT_SENTINEL marks "no formant in slot"; hold the
    // previous valid value visually rather than collapsing the vertex
    // to (0,0).
    if (formantsOut.f1Hz > FORMANT_ABSENT_SENTINEL && formantsOut.f2Hz > FORMANT_ABSENT_SENTINEL) {
        voice.f1Hz = formantsOut.f1Hz;
        voice.f2Hz = formantsOut.f2Hz;

        return true;
    }

    return false;
}
