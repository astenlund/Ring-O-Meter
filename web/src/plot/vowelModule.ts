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

import type {FormantFrame, FrameRingReader} from '../audio/frameRing';
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
// variable-voice-count pattern's range (1-8 voices).
const MAX_VOICES = 8;

export interface VoicePoint {
    channelId: string;
    color: string;          // 3- or 6-digit hex from SLOT_COLORS
    f1Hz: number;           // last-known F1 (held when gate fails)
    f2Hz: number;           // last-known F2 (held when gate fails)
    isDimmed: boolean;      // post-debounce gate state
    hasEverPublished: boolean; // false until the first formant frame arrives
}

// Sort voice points by polar angle around their centroid. Returns
// the ordering as an index permutation into `points`. Stable
// tie-break on channelId so degenerate cases (collinear, identical
// positions) produce deterministic ordering.
//
// Allocates the result array; the per-renderer paint modules
// (Task 10's vowelModuleWebgpu, Task 11's 2D paint helpers) will
// own their own zero-alloc sort variants writing into a hoisted
// Int32Array scratch buffer for the per-frame hot path.
export function polarAngleSort(points: ReadonlyArray<VoicePoint>): number[] {
    if (points.length <= 2) {
        return points.map((_, i) => i);
    }
    let cx = 0;
    let cy = 0;
    for (const p of points) {
        cx += p.f2Hz;
        cy += p.f1Hz;
    }
    cx /= points.length;
    cy /= points.length;
    const indices = points.map((_, i) => i);
    indices.sort((a, b) => {
        const angleA = Math.atan2(points[a].f1Hz - cy, points[a].f2Hz - cx);
        const angleB = Math.atan2(points[b].f1Hz - cy, points[b].f2Hz - cx);
        if (angleA !== angleB) {
            return angleA - angleB;
        }

        return points[a].channelId.localeCompare(points[b].channelId);
    });

    return indices;
}

// Compute the polygon-area metric in Hz^2. For N >= 3, shoelace
// formula on the points in the supplied ordering. For N = 2, returns
// the squared edge length (the polygon degenerates to a single
// segment). For N = 0 or 1, returns NaN (no inter-voice spread).
export function polygonAreaMetric(
    points: ReadonlyArray<VoicePoint>,
    ordering: ReadonlyArray<number>,
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
    // Detector emits 0 when no formant in slot; hold the previous
    // valid value visually rather than collapsing the vertex to (0,0).
    if (formantsOut.f1Hz > 0 && formantsOut.f2Hz > 0) {
        voice.f1Hz = formantsOut.f1Hz;
        voice.f2Hz = formantsOut.f2Hz;

        return true;
    }

    return false;
}
