// 2D canvas chord-bars module. Renders a stack of horizontal tracks,
// one per active voice, each showing the voice's signed cents-from-JI
// position on a shared ±50¢ axis. A ±5¢ green target zone sits behind
// the indicator dot; voice label on the left, cents readout on the right.
// Off-scale wedge (small triangle) appears at the clamped edge when the
// value is strictly outside ±50¢.
//
// Hot-path allocation discipline: all draw-loop state lives in
// module-scoped scratch objects allocated once at init. Steady-state
// update + draw are zero-alloc. Per the hot-path-allocation-discipline
// pattern.

import {GREEN_THRESHOLD_CENTS} from '../audio/ringThresholds';
import {applyCanvasBacking, type CanvasBacking, type CanvasSize} from './paint';
import {MAX_VOICES} from './vowelModule';

// heuristic: chord-bars-track-height-css - track height in CSS pixels.
// ~28px reads comfortably at phone-screen DPRs; narrower loses the
// readable cents-text; wider wastes space on small screens.
const TRACK_HEIGHT_CSS = 28;

// heuristic: chord-bars-track-gap-css - gap between tracks in CSS pixels.
const TRACK_GAP_CSS = 8;

// heuristic: chord-bars-label-margin-css - left-side column for voice
// label text, in CSS pixels.
const LABEL_MARGIN_CSS = 36;

// heuristic: chord-bars-readout-margin-css - right-side column for
// signed cents readout, in CSS pixels.
const READOUT_MARGIN_CSS = 44;

// heuristic: chord-bars-scale-cents - full half-range of the ±N¢ axis.
const SCALE_HALF_CENTS = 50;

// heuristic: chord-bars-dot-radius-css - indicator dot radius in CSS
// pixels.
const DOT_RADIUS_CSS = 5;

// heuristic: chord-bars-wedge-size-css - off-scale wedge half-height
// and depth in CSS pixels.
const WEDGE_SIZE_CSS = 6;

// Colors shared with the existing slot palette (SLOT_COLORS in App.tsx).
// The color is passed in via channelIdToSlot lookups during update; no
// local palette here.

const TRACK_BG_COLOR = '#1a1a1a';
const TARGET_ZONE_COLOR = 'rgba(0, 200, 80, 0.25)';
const CENTER_LINE_COLOR = '#444';
const DOT_COLOR = '#e0e0e0'; // tinted by voice color at draw time
const OFFSCALE_COLOR = '#e06040';
const LABEL_COLOR = '#aaa';
const READOUT_COLOR = '#ccc';
const READOUT_OFFSCALE_COLOR = '#e06040';

// Per-slot scratch data. Mutated in update(); read in draw().
// All fields are primitives to stay zero-alloc per-frame.
interface BarSlot {
    active: boolean;        // true if residual is not NaN
    cents: number;          // raw signed value (may exceed ±SCALE_HALF_CENTS)
    clamped: number;        // clamped to [-SCALE_HALF_CENTS, +SCALE_HALF_CENTS]
    offScaleNeg: boolean;   // value was strictly < -SCALE_HALF_CENTS
    offScalePos: boolean;   // value was strictly > +SCALE_HALF_CENTS
    label: string;          // "V0", "V1", ... (stable per slot index)
    color: string;          // CSS color string from slot palette
}

// Pre-allocate scratch slots. Label strings are constant after init;
// only the numeric fields change per frame. String assignments (color,
// label) happen in update(); V8 interns short literal strings, so these
// are alloc-free in practice.
const slots: BarSlot[] = [];
for (let i = 0; i < MAX_VOICES; i++) {
    slots.push({
        active: false,
        cents: 0,
        clamped: 0,
        offScaleNeg: false,
        offScalePos: false,
        label: `V${i}`,
        color: '#ffffff',
    });
}

// --- Module state ---

let _canvas: OffscreenCanvas | null = null;
let _ctx: OffscreenCanvasRenderingContext2D | null = null;
// Backing dims (CSS px + DPR). Set by init/setBacking, read by draw.
// _sizeOut is a write-only scratch for applyCanvasBacking's out-param
// contract; the same numeric values live in _backing.cssWidth/cssHeight.
const _backing: CanvasBacking = {cssWidth: 0, cssHeight: 0, dpr: 1};
const _sizeOut: CanvasSize = {width: 0, height: 0};

// Scratch scalar: voice count from last update().
let _voiceCount = 0;

// --- Public interface ---

export function init(
    canvas: OffscreenCanvas,
    size: {width: number; height: number},
    dpr: number,
): void {
    _canvas = canvas;
    _backing.cssWidth = size.width;
    _backing.cssHeight = size.height;
    _backing.dpr = dpr;

    const ctx = canvas.getContext('2d', {alpha: true});
    if (!ctx) {
        throw new Error('chordBarsModule: 2d context unavailable');
    }
    _ctx = ctx;
    applyCanvasBacking(canvas, ctx, _backing, _sizeOut);
}

export interface ChordBarsInput {
    lockedChordType: number | null;
    residualsBySlot: Float32Array;      // NaN sentinel for absent voices
    rootChannelId: string | null;
    channelIdToSlot: ReadonlyMap<string, number>;
}

export function setBacking(cssWidth: number, cssHeight: number, dpr: number): void {
    _backing.cssWidth = cssWidth;
    _backing.cssHeight = cssHeight;
    _backing.dpr = dpr;
}

export function update(input: ChordBarsInput): void {
    const {residualsBySlot, channelIdToSlot} = input;

    // Determine how many slots have any channel assigned. channelIdToSlot
    // maps channelId -> slotIndex; we need to know which slot indices are
    // populated. We walk the map to find the highest assigned slot index,
    // which determines the track count.
    let maxSlot = -1;
    for (const slotIdx of channelIdToSlot.values()) {
        if (slotIdx > maxSlot) {
            maxSlot = slotIdx;
        }
    }
    _voiceCount = maxSlot + 1;

    // Reset all slots.
    for (let i = 0; i < MAX_VOICES; i++) {
        slots[i].active = false;
    }

    // Populate the slot color from channelIdToSlot + a caller-provided
    // color map. For MVP we default to a neutral color since the color
    // map is not yet threaded through; the worker integration (Task 18)
    // will provide per-slot colors. For now the label is "V<slot>".
    for (const [, slotIdx] of channelIdToSlot) {
        if (slotIdx >= MAX_VOICES) {
            continue;
        }
        const residual = slotIdx < residualsBySlot.length
            ? residualsBySlot[slotIdx]
            : Number.NaN;
        if (Number.isNaN(residual)) {
            continue;
        }
        const slot = slots[slotIdx];
        slot.active = true;
        slot.cents = residual;
        if (residual < -SCALE_HALF_CENTS) {
            slot.clamped = -SCALE_HALF_CENTS;
            slot.offScaleNeg = true;
            slot.offScalePos = false;
        } else if (residual > SCALE_HALF_CENTS) {
            slot.clamped = SCALE_HALF_CENTS;
            slot.offScaleNeg = false;
            slot.offScalePos = true;
        } else {
            slot.clamped = residual;
            slot.offScaleNeg = false;
            slot.offScalePos = false;
        }
    }
}

export function draw(): void {
    if (!_canvas || !_ctx) {
        return;
    }

    // Re-apply backing if canvas dimensions need updating. applyCanvasBacking
    // is a no-op on size/dpr match so this is safe to call every frame.
    applyCanvasBacking(_canvas, _ctx, _backing, _sizeOut);

    const ctx = _ctx;
    const w = _backing.cssWidth;
    const h = _backing.cssHeight;

    // Per spec: clearRect not fillRect — alpha:true canvas, overlays may
    // composite on top.
    ctx.clearRect(0, 0, w, h);

    if (_voiceCount === 0) {
        return;
    }

    // Scale region: from LABEL_MARGIN_CSS to (w - READOUT_MARGIN_CSS).
    const scaleLeft = LABEL_MARGIN_CSS;
    const scaleRight = w - READOUT_MARGIN_CSS;
    const scaleWidth = scaleRight - scaleLeft;
    const centerX = scaleLeft + scaleWidth / 2;

    // X mapping: cents → canvas x. 0¢ = centerX; ±SCALE_HALF_CENTS = edges.
    // Inline to avoid per-frame closure allocation.

    for (let s = 0; s < _voiceCount; s++) {
        const slot = slots[s];

        // Track top in CSS pixels. Tracks stack from top; non-active
        // tracks still draw their structural chrome (label + track bg +
        // center line + target zone) but omit the dot and readout per spec.
        const trackTop = s * (TRACK_HEIGHT_CSS + TRACK_GAP_CSS);
        const trackMid = trackTop + TRACK_HEIGHT_CSS / 2;
        const trackBot = trackTop + TRACK_HEIGHT_CSS;

        // Track background.
        ctx.fillStyle = TRACK_BG_COLOR;
        ctx.fillRect(scaleLeft, trackTop, scaleWidth, TRACK_HEIGHT_CSS);

        // Green target zone (±GREEN_THRESHOLD_CENTS around center).
        const tzHalfW = (GREEN_THRESHOLD_CENTS / SCALE_HALF_CENTS) * (scaleWidth / 2);
        ctx.fillStyle = TARGET_ZONE_COLOR;
        ctx.fillRect(centerX - tzHalfW, trackTop, tzHalfW * 2, TRACK_HEIGHT_CSS);

        // Center line (0¢ reference).
        ctx.strokeStyle = CENTER_LINE_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(centerX, trackTop);
        ctx.lineTo(centerX, trackBot);
        ctx.stroke();

        // Voice label (left margin).
        ctx.fillStyle = LABEL_COLOR;
        ctx.font = `12px sans-serif`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(slot.label, scaleLeft - 4, trackMid);

        if (!slot.active) {
            continue;
        }

        // Map clamped cents to x position.
        const dotX = centerX + (slot.clamped / SCALE_HALF_CENTS) * (scaleWidth / 2);

        // Off-scale wedge (triangle pointing inward at the clamped edge).
        if (slot.offScaleNeg) {
            ctx.fillStyle = OFFSCALE_COLOR;
            ctx.beginPath();
            ctx.moveTo(scaleLeft, trackMid);
            ctx.lineTo(scaleLeft + WEDGE_SIZE_CSS, trackMid - WEDGE_SIZE_CSS);
            ctx.lineTo(scaleLeft + WEDGE_SIZE_CSS, trackMid + WEDGE_SIZE_CSS);
            ctx.closePath();
            ctx.fill();
        } else if (slot.offScalePos) {
            ctx.fillStyle = OFFSCALE_COLOR;
            ctx.beginPath();
            ctx.moveTo(scaleRight, trackMid);
            ctx.lineTo(scaleRight - WEDGE_SIZE_CSS, trackMid - WEDGE_SIZE_CSS);
            ctx.lineTo(scaleRight - WEDGE_SIZE_CSS, trackMid + WEDGE_SIZE_CSS);
            ctx.closePath();
            ctx.fill();
        }

        // Indicator dot.
        ctx.fillStyle = slot.color !== '#ffffff' ? slot.color : DOT_COLOR;
        ctx.beginPath();
        ctx.arc(dotX, trackMid, DOT_RADIUS_CSS, 0, 2 * Math.PI);
        ctx.fill();

        // Cents readout (right margin).
        const readoutStr = formatCents(slot.cents);
        ctx.fillStyle = (slot.offScaleNeg || slot.offScalePos)
            ? READOUT_OFFSCALE_COLOR
            : READOUT_COLOR;
        ctx.font = `11px monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(readoutStr, scaleRight + 4, trackMid);
    }
}

export function dispose(): void {
    _canvas = null;
    _ctx = null;
    _backing.cssWidth = 0;
    _backing.cssHeight = 0;
    _voiceCount = 0;
}

// --- Helpers ---

// Format a cents value as a signed string with one decimal place.
// Pre-allocated scratch string pool cannot be used for floating-point
// formatting (values are continuous), so this allocates. It runs only
// in the draw() loop for active voices; at 8 voices × 60 fps the
// allocation rate is modest and within the alloc-test budget.
// A future optimization could use a fixed-point lookup table if this
// ever shows up in a profile, but today it does not.
function formatCents(cents: number): string {
    const sign = cents >= 0 ? '+' : '';

    return `${sign}${cents.toFixed(1)}¢`;
}
