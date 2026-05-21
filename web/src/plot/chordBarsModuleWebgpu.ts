// WebGPU paint pipeline for the chord-aware-display bars visualization.
// Owns its own GPUCanvasContext (dedicated OffscreenCanvas) and appends
// a render pass to the shared GPUCommandEncoder each frame.
//
// Render contract: configures the canvas with alphaMode: 'premultiplied'
// and uses loadOp: 'clear' + clearValue: {r:0,g:0,b:0,a:0} so the
// canvas remains compositable for downstream overlay features
// (per chord-aware-display.md Forward-fit notes).

import {hexToRgba} from './color';

// heuristic: chord-bars-range-cents
const RANGE_CENTS = 50;

// heuristic: chord-bars-green-threshold-cents
const GREEN_THRESHOLD_CENTS = 5;

// heuristic: chord-bars-yellow-band-outer-cents
const YELLOW_BAND_OUTER_CENTS = 15;

// heuristic: max-voices-chord-classification
const MAX_VOICES = 8;

// Vertex layout: position (f32x2) at offset 0, color (f32x4) at offset 8.
// Stride = 24 bytes.
const VERT_FLOATS = 6;
const VERT_BYTES = VERT_FLOATS * 4; // 24

// Per-slot component breakdown (triangle-list, 6 verts per quad):
//   background track:   6
//   center line:        6
//   green zone:         6
//   left yellow band:   6
//   right yellow band:  6
//   dot (if active):    6
//   left wedge tri:     3
//   right wedge tri:    3
// Total per slot: 48 vertices max
const VERTS_PER_SLOT = 48;
const STAGING_VERTS = MAX_VOICES * VERTS_PER_SLOT;

// Viewport uniform: (widthPx, heightPx, dpr, _pad) as f32x4.
const VIEWPORT_UNIFORM_BYTES = 16;

// SLOT_COLORS palette — mirrors App.tsx SLOT_COLORS; bar colors are
// supplied per-slot by the caller via channelIdToSlot + a
// per-slot-color array updated from SetRoster-style data. In the
// interim (before Task 18 wires the color map), bars fall back to
// white.
const FALLBACK_COLOR: Readonly<Float32Array> = new Float32Array([1, 1, 1, 1]);

// Passive colors (not voice-keyed).
const BG_COLOR        = new Float32Array([0.1, 0.1, 0.12, 1.0]);
const CENTER_COLOR    = new Float32Array([0.35, 0.35, 0.38, 1.0]);
const GREEN_COLOR     = new Float32Array([0.1, 0.55, 0.2, 0.35]);
const YELLOW_COLOR    = new Float32Array([0.55, 0.5, 0.08, 0.25]);
const WEDGE_COLOR     = new Float32Array([0.9, 0.4, 0.15, 0.8]);

export interface ChordBarsInput {
    readonly lockedChordType: number | null;
    readonly residualsBySlot: Float32Array;
    readonly rootChannelId: string | null;
    readonly channelIdToSlot: ReadonlyMap<string, number>;
}

export class ChordBarsModuleWebgpu {
    private context: GPUCanvasContext | null = null;
    private device: GPUDevice | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private vertexBuffer: GPUBuffer | null = null;
    private viewportUniform: GPUBuffer | null = null;
    private bindGroup: GPUBindGroup | null = null;
    private format: GPUTextureFormat = 'bgra8unorm';

    // Pre-allocated CPU staging buffer; refilled per update().
    private readonly staging = new Float32Array(STAGING_VERTS * VERT_FLOATS);
    private readonly viewportData = new Float32Array(4);

    // Per-slot color arrays, pre-allocated at MAX_VOICES capacity.
    private readonly slotColors: Float32Array[] = Array.from(
        {length: MAX_VOICES},
        () => new Float32Array([1, 1, 1, 1]),
    );

    // Number of vertices written this frame; drives draw() vertex count.
    private vertexCount = 0;

    private cssWidth = 0;
    private cssHeight = 0;
    private dpr = 1;
    private viewportDirty = true;

    // Most-recently applied input. Copied defensively so update()
    // owns its own snapshot without sharing a reference to the
    // caller's mutable Float32Array.
    private readonly residualsSnapshot = new Float32Array(MAX_VOICES);
    private lockedChordType: number | null = null;
    private slotCount = 0;

    public init(canvas: OffscreenCanvas, device: GPUDevice): void {
        this.device = device;
        this.format = navigator.gpu.getPreferredCanvasFormat();

        const ctx = canvas.getContext('webgpu') as GPUCanvasContext | null;
        if (!ctx) {
            throw new Error('ChordBarsModuleWebgpu: webgpu context unavailable');
        }
        // alphaMode: 'premultiplied' keeps the canvas compositable
        // per chord-aware-display.md Forward-fit notes.
        ctx.configure({
            device,
            format: this.format,
            alphaMode: 'premultiplied',
        });
        this.context = ctx;

        const bindGroupLayout = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX,
                buffer: {type: 'uniform'},
            }],
        });

        const pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout],
        });

        const shaderModule = device.createShaderModule({code: CHORD_BARS_WGSL});

        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: VERT_BYTES,
            attributes: [
                {shaderLocation: 0, offset: 0, format: 'float32x2'},
                {shaderLocation: 1, offset: 8, format: 'float32x4'},
            ],
        };

        this.pipeline = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [vertexBufferLayout],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one-minus-src-alpha',
                            operation: 'add',
                        },
                    },
                }],
            },
            primitive: {topology: 'triangle-list'},
        });

        this.viewportUniform = device.createBuffer({
            size: VIEWPORT_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.vertexBuffer = device.createBuffer({
            size: STAGING_VERTS * VERT_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        this.bindGroup = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [{
                binding: 0,
                resource: {buffer: this.viewportUniform},
            }],
        });
    }

    /**
     * Set canvas dimensions. Called when the backing OffscreenCanvas
     * is resized. Also resizes the canvas's device-pixel dimensions
     * and reconfigures the GPUCanvasContext.
     */
    public setBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        this.cssWidth = cssWidth;
        this.cssHeight = cssHeight;
        this.dpr = dpr;
        this.viewportDirty = true;

        if (!this.context || !this.device || cssWidth === 0 || cssHeight === 0) {
            return;
        }
        const canvas = this.context.canvas as OffscreenCanvas;
        const w = Math.round(cssWidth * dpr);
        const h = Math.round(cssHeight * dpr);
        canvas.width = w;
        canvas.height = h;
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'premultiplied',
        });
    }

    /**
     * Register a per-slot color so bars render in the voice's slot color.
     * Called by the worker when AttachChannel maps a channelId to a slot.
     * `slotIndex` is the 0-based slot index; `hexColor` is a CSS hex
     * string (e.g. '#5cf').
     */
    public setSlotColor(slotIndex: number, hexColor: string): void {
        if (slotIndex < 0 || slotIndex >= MAX_VOICES) {
            return;
        }
        try {
            hexToRgba(hexColor, this.slotColors[slotIndex]);
        } catch {
            // Fall back to white on unparseable color; transient render
            // glitch is preferable to a crash.
            this.slotColors[slotIndex].set(FALLBACK_COLOR);
        }
    }

    /**
     * Absorb a chord-classification update and rebuild the vertex staging
     * buffer. Zero-alloc in steady state: all arrays are pre-allocated.
     */
    public update(input: ChordBarsInput): void {
        if (!this.device || this.cssHeight === 0) {
            return;
        }

        // Upload viewport uniform if dirty (backing change).
        if (this.viewportDirty) {
            const wPx = this.cssWidth * this.dpr;
            const hPx = this.cssHeight * this.dpr;
            this.viewportData[0] = wPx;
            this.viewportData[1] = hPx;
            this.viewportData[2] = this.dpr;
            this.viewportData[3] = 0;
            this.device.queue.writeBuffer(this.viewportUniform!, 0, this.viewportData);
            this.viewportDirty = false;
        }

        // Snapshot residuals (Float32Array is caller-owned and reused).
        this.lockedChordType = input.lockedChordType;
        this.slotCount = Math.min(input.channelIdToSlot.size, MAX_VOICES);
        this.residualsSnapshot.set(input.residualsBySlot);

        // Rebuild vertex geometry into this.staging.
        this.vertexCount = buildGeometry(
            this.staging,
            this.residualsSnapshot,
            this.slotCount,
            this.lockedChordType !== null,
            this.slotColors,
            this.cssWidth * this.dpr,
            this.cssHeight * this.dpr,
        );

        if (this.vertexCount > 0) {
            this.device.queue.writeBuffer(
                this.vertexBuffer!,
                0,
                this.staging.buffer,
                this.staging.byteOffset,
                this.vertexCount * VERT_BYTES,
            );
        }
    }

    /**
     * Append a render pass to the shared command encoder. The pass
     * uses loadOp: 'clear' with a transparent clearValue so no opaque
     * fill overwrites the compositable alpha channel.
     */
    public draw(encoder: GPUCommandEncoder): void {
        if (!this.context || !this.pipeline || !this.bindGroup || !this.vertexBuffer) {
            return;
        }
        if (this.vertexCount === 0) {
            return;
        }

        let view: GPUTextureView;
        try {
            view = this.context.getCurrentTexture().createView();
        } catch {
            // getCurrentTexture can throw if the canvas has been detached
            // or the context lost. Silently skip this frame.
            return;
        }

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view,
                // Transparent clear — keeps the canvas compositable
                // per chord-aware-display.md Forward-fit notes.
                clearValue: {r: 0, g: 0, b: 0, a: 0},
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.setVertexBuffer(0, this.vertexBuffer);
        pass.draw(this.vertexCount);
        pass.end();
    }

    public dispose(): void {
        this.vertexBuffer?.destroy();
        this.viewportUniform?.destroy();
        this.vertexBuffer = null;
        this.viewportUniform = null;
        this.pipeline = null;
        this.bindGroup = null;
        this.device = null;
        this.context = null;
        this.vertexCount = 0;
    }
}

// ===== Geometry builder =====
//
// Pure function (no allocations beyond the pre-supplied staging buffer).
// Returns the number of vertices written.
//
// Device-pixel coordinates are used throughout. NDC is computed in the
// vertex shader via the viewport uniform (widthPx, heightPx).
// Pixel coordinate convention: top-left = (0, 0), y increases downward.
// NDC: x = 2*px/W - 1, y = 1 - 2*py/H (standard WebGPU convention).
//
// Layout:
//   TRACK_PAD px vertical padding between tracks.
//   Each track occupies `trackH` px of height (slotCount tracks total).
//   Dot half-size = DOT_PX / 2.
//   Center line height = CENTER_LINE_H px.
//
// heuristic: chord-bars-track-padding-px
const TRACK_PAD_PX = 4;
// heuristic: chord-bars-dot-size-px
const DOT_PX = 10;
// heuristic: chord-bars-center-line-height-px
const CENTER_LINE_H_PX = 2;
// heuristic: chord-bars-wedge-size-px
const WEDGE_PX = 8;

function buildGeometry(
    staging: Float32Array,
    residuals: Float32Array,
    slotCount: number,
    chordLocked: boolean,
    slotColors: Float32Array[],
    wPx: number,
    hPx: number,
): number {
    if (slotCount === 0 || wPx === 0 || hPx === 0) {
        return 0;
    }

    const totalPad = TRACK_PAD_PX * (slotCount + 1);
    const trackH = (hPx - totalPad) / slotCount;
    if (trackH <= 0) {
        return 0;
    }

    // Horizontal mapping: center of canvas = 0 cents, ±RANGE_CENTS
    // maps to ±halfW.
    const halfW = wPx / 2;
    const pxPerCent = halfW / RANGE_CENTS;

    // Green zone half-width in px.
    const greenHalf = GREEN_THRESHOLD_CENTS * pxPerCent;
    // Yellow outer half-width in px.
    const yellowOuter = YELLOW_BAND_OUTER_CENTS * pxPerCent;

    let vi = 0;

    for (let s = 0; s < slotCount; s++) {
        const topY = TRACK_PAD_PX + s * (trackH + TRACK_PAD_PX);
        const botY = topY + trackH;
        const midY = (topY + botY) / 2;

        // 1. Background track (full width, dim).
        vi = writeQuad(staging, vi, 0, topY, wPx, botY, BG_COLOR);

        // 2. Center line (full width, slightly brighter).
        const clHalf = CENTER_LINE_H_PX / 2;
        vi = writeQuad(staging, vi, 0, midY - clHalf, wPx, midY + clHalf, CENTER_COLOR);

        // 3. Zone overlays only when chord is locked.
        if (chordLocked) {
            // Left yellow band: from -YELLOW_BAND_OUTER to -GREEN_THRESHOLD.
            const ly0 = halfW - yellowOuter;
            const ly1 = halfW - greenHalf;
            if (ly1 > ly0) {
                vi = writeQuad(staging, vi, ly0, topY, ly1, botY, YELLOW_COLOR);
            }
            // Right yellow band: from +GREEN_THRESHOLD to +YELLOW_BAND_OUTER.
            const ry0 = halfW + greenHalf;
            const ry1 = halfW + yellowOuter;
            if (ry1 > ry0) {
                vi = writeQuad(staging, vi, ry0, topY, ry1, botY, YELLOW_COLOR);
            }
            // Green zone: center ±GREEN_THRESHOLD.
            vi = writeQuad(staging, vi, halfW - greenHalf, topY, halfW + greenHalf, botY, GREEN_COLOR);
        }

        // 4. Dot + off-scale wedge (only when chord locked and residual valid).
        const residual = residuals[s];
        if (chordLocked && Number.isFinite(residual)) {
            const clamped = Math.max(-RANGE_CENTS, Math.min(RANGE_CENTS, residual));
            const dotCx = halfW + clamped * pxPerCent;
            const dotHalf = DOT_PX / 2;
            const dotX0 = dotCx - dotHalf;
            const dotX1 = dotCx + dotHalf;
            const dotY0 = midY - dotHalf;
            const dotY1 = midY + dotHalf;

            const col = slotColors[s];
            vi = writeQuad(staging, vi, dotX0, dotY0, dotX1, dotY1, col);

            // Off-scale left wedge (residual strictly < -RANGE_CENTS).
            if (residual < -RANGE_CENTS) {
                vi = writeLeftWedge(staging, vi, WEDGE_PX, midY, WEDGE_COLOR);
            }
            // Off-scale right wedge (residual strictly > +RANGE_CENTS).
            if (residual > RANGE_CENTS) {
                vi = writeRightWedge(staging, vi, wPx - WEDGE_PX, midY, WEDGE_COLOR);
            }
        }
    }

    return vi;
}

// Write a solid axis-aligned quad as two triangles (6 vertices).
// Coordinates are in device pixels; the vertex shader converts to NDC.
function writeQuad(
    buf: Float32Array,
    vi: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    col: Float32Array,
): number {
    const r = col[0];
    const g = col[1];
    const b = col[2];
    const a = col[3];
    // Triangle 1: TL, TR, BL
    buf[vi * VERT_FLOATS]     = x0; buf[vi * VERT_FLOATS + 1] = y0;
    buf[vi * VERT_FLOATS + 2] = r;  buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;  buf[vi * VERT_FLOATS + 5] = a;
    vi++;
    buf[vi * VERT_FLOATS]     = x1; buf[vi * VERT_FLOATS + 1] = y0;
    buf[vi * VERT_FLOATS + 2] = r;  buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;  buf[vi * VERT_FLOATS + 5] = a;
    vi++;
    buf[vi * VERT_FLOATS]     = x0; buf[vi * VERT_FLOATS + 1] = y1;
    buf[vi * VERT_FLOATS + 2] = r;  buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;  buf[vi * VERT_FLOATS + 5] = a;
    vi++;
    // Triangle 2: TR, BR, BL
    buf[vi * VERT_FLOATS]     = x1; buf[vi * VERT_FLOATS + 1] = y0;
    buf[vi * VERT_FLOATS + 2] = r;  buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;  buf[vi * VERT_FLOATS + 5] = a;
    vi++;
    buf[vi * VERT_FLOATS]     = x1; buf[vi * VERT_FLOATS + 1] = y1;
    buf[vi * VERT_FLOATS + 2] = r;  buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;  buf[vi * VERT_FLOATS + 5] = a;
    vi++;
    buf[vi * VERT_FLOATS]     = x0; buf[vi * VERT_FLOATS + 1] = y1;
    buf[vi * VERT_FLOATS + 2] = r;  buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;  buf[vi * VERT_FLOATS + 5] = a;
    vi++;

    return vi;
}

// Left off-scale wedge: right-pointing triangle at the left edge.
// Tip at (tipX, midY), base spans ±WEDGE_PX in Y.
function writeLeftWedge(
    buf: Float32Array,
    vi: number,
    tipX: number,
    midY: number,
    col: Float32Array,
): number {
    const r = col[0];
    const g = col[1];
    const b = col[2];
    const a = col[3];
    const baseX = 0;
    const halfH = WEDGE_PX / 2;
    buf[vi * VERT_FLOATS]     = tipX; buf[vi * VERT_FLOATS + 1] = midY;
    buf[vi * VERT_FLOATS + 2] = r;   buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;   buf[vi * VERT_FLOATS + 5] = a;
    vi++;
    buf[vi * VERT_FLOATS]     = baseX; buf[vi * VERT_FLOATS + 1] = midY - halfH;
    buf[vi * VERT_FLOATS + 2] = r;    buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;    buf[vi * VERT_FLOATS + 5] = a;
    vi++;
    buf[vi * VERT_FLOATS]     = baseX; buf[vi * VERT_FLOATS + 1] = midY + halfH;
    buf[vi * VERT_FLOATS + 2] = r;    buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;    buf[vi * VERT_FLOATS + 5] = a;
    vi++;

    return vi;
}

// Right off-scale wedge: left-pointing triangle at the right edge.
// Tip at (tipX, midY), base at canvas right edge.
function writeRightWedge(
    buf: Float32Array,
    vi: number,
    tipX: number,
    midY: number,
    col: Float32Array,
): number {
    const r = col[0];
    const g = col[1];
    const b = col[2];
    const a = col[3];
    const halfH = WEDGE_PX / 2;
    buf[vi * VERT_FLOATS]     = tipX;      buf[vi * VERT_FLOATS + 1] = midY;
    buf[vi * VERT_FLOATS + 2] = r;         buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;         buf[vi * VERT_FLOATS + 5] = a;
    vi++;
    // Note: wPx is not passed here; writeRightWedge receives tipX which
    // is already (wPx - WEDGE_PX). The right base is at (tipX + WEDGE_PX).
    const baseX = tipX + WEDGE_PX;
    buf[vi * VERT_FLOATS]     = baseX; buf[vi * VERT_FLOATS + 1] = midY - halfH;
    buf[vi * VERT_FLOATS + 2] = r;    buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;    buf[vi * VERT_FLOATS + 5] = a;
    vi++;
    buf[vi * VERT_FLOATS]     = baseX; buf[vi * VERT_FLOATS + 1] = midY + halfH;
    buf[vi * VERT_FLOATS + 2] = r;    buf[vi * VERT_FLOATS + 3] = g;
    buf[vi * VERT_FLOATS + 4] = b;    buf[vi * VERT_FLOATS + 5] = a;
    vi++;

    return vi;
}

// ===== WGSL shader source =====
//
// Vertex shader: converts device-pixel coordinates to NDC using the
// viewport uniform. Fragment shader: passes the interpolated color
// through as premultiplied alpha output.

const CHORD_BARS_WGSL = /* wgsl */`
struct Viewport {
    widthPx:  f32,
    heightPx: f32,
    dpr:      f32,
    _pad:     f32,
};

@group(0) @binding(0)
var<uniform> viewport: Viewport;

struct VsIn {
    @location(0) positionPx: vec2<f32>,
    @location(1) color:      vec4<f32>,
};

struct VsOut {
    @builtin(position) position: vec4<f32>,
    @location(0)       color:    vec4<f32>,
};

@vertex
fn vs_main(input: VsIn) -> VsOut {
    var out: VsOut;
    // Device-pixel -> NDC: x = 2*px/W - 1, y = 1 - 2*py/H.
    let ndcX =  2.0 * input.positionPx.x / viewport.widthPx  - 1.0;
    let ndcY =  1.0 - 2.0 * input.positionPx.y / viewport.heightPx;
    out.position = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
    out.color    = input.color;
    return out;
}

struct FsIn {
    @location(0) color: vec4<f32>,
};

@fragment
fn fs_main(input: FsIn) -> @location(0) vec4<f32> {
    return input.color;
}
`;
