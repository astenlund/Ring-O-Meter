// WebGPU paint pipeline for the vowel polygon visualization. Implements
// RenderModule so it can be hosted by the plot worker's render system
// alongside TraceModule. Owns the polygon line-strip pipeline, the dot
// triangle-list pipeline, and per-frame vertex buffer updates.
//
// Shared logic (gating, ordering, polygon-area metric) lives in
// vowelModule.ts; this file is purely GPU pipeline + buffer management.

import type {FormantFrame, FrameRingReader} from '../audio/frameRing';
import type {RenderModule} from './renderModule';
import {hexToRgba} from './color';
import type {VoiceEntry} from './plotMessages';
import {
    GateDebounce,
    MAX_VOICES,
    OrderDebounce,
    VOWEL_DIM_BRIGHTNESS,
    consumeLatestFrame,
    polarAngleSortInto,
    type VoicePoint,
} from './vowelModule';

// heuristic: vowel-dot-css-size - dot side length in CSS pixels; the
// GPU computes device-pixel size as round(N * dpr). 4 reads as a
// crisp pixel marker at typical DPRs (4, 8, 10 device px); larger
// values feel "bubbly", smaller values disappear at high DPR.
const VOWEL_DOT_CSS_SIZE = 4;

// Adult-inclusive (both male and female) F1/F2 ranges, narrowly
// excluding child voices. Linear Hz on both axes; perceptual scales
// (Bark, mel, log-Hz) are an explicit anti-goal because they compress
// F2 where ring coaching needs amplification (see spec "Axis
// convention" and CLAUDE.md "Vowel-matching metric uses raw absolute Hz").
// The four bounds are tagged for the heuristic registry: the
// visualization range is itself a coaching surface, and a future
// session that introduces child voices, a non-IPA convention, or a
// per-cohort-tuned axis would discover them via grep "// heuristic:".
// heuristic: vowel-axis-f1-min - lower bound on F1 axis
const F1_MIN = 200;
// heuristic: vowel-axis-f1-max - upper bound on F1 axis
const F1_MAX = 1100;
// heuristic: vowel-axis-f2-min - lower bound on F2 axis
const F2_MIN = 700;
// heuristic: vowel-axis-f2-max - upper bound on F2 axis
const F2_MAX = 3300;
const F1_SPAN = F1_MAX - F1_MIN;
const F2_SPAN = F2_MAX - F2_MIN;

// Polygon vertex buffer: MAX_VOICES + 1 for the closed-loop indexed
// draw (last index = first vertex re-referenced). Each vertex is
// (xNdc, yNdc, r, g, b, a) = 6 floats.
const POLY_VERTEX_FLOATS = 6;
const POLY_VERTEX_BYTES = POLY_VERTEX_FLOATS * 4;

// Dot vertex buffer: 6 vertices per dot (two triangles), MAX_VOICES
// dots. Same vertex layout as polygon.
const DOT_VERTICES_PER_VOICE = 6;
const DOT_TOTAL_VERTICES = MAX_VOICES * DOT_VERTICES_PER_VOICE;

// Viewport uniform: (width_px, height_px, dpr, _pad) as f32x4.
const VIEWPORT_UNIFORM_BYTES = 16;

interface VoiceState {
    channelId: string;
    color: string;
    reader: FrameRingReader;
    point: VoicePoint;
    debounce: GateDebounce;
    // Pre-allocated color arrays to avoid per-frame Float32Array alloc.
    readonly fullColor: Float32Array; // [r, g, b, 1]
    readonly dimColor: Float32Array;  // [r * VOWEL_DIM_BRIGHTNESS, g * VOWEL_DIM_BRIGHTNESS, b * VOWEL_DIM_BRIGHTNESS, 1]
}

export class VowelModuleWebgpu implements RenderModule {
    private device: GPUDevice | null = null;
    private queue: GPUQueue | null = null;
    private polygonPipeline: GPURenderPipeline | null = null;
    private dotPipeline: GPURenderPipeline | null = null;
    private viewportUniform: GPUBuffer | null = null;
    private polygonVertexBuffer: GPUBuffer | null = null;
    private polygonIndexBuffer: GPUBuffer | null = null;
    private dotVertexBuffer: GPUBuffer | null = null;
    private bindGroup: GPUBindGroup | null = null;

    // Pre-allocated CPU staging buffers; reused per frame to avoid
    // per-frame allocation pressure on the hot path.
    private readonly viewportData = new Float32Array(4);
    private readonly polygonStaging = new Float32Array((MAX_VOICES + 1) * POLY_VERTEX_FLOATS);
    private readonly dotStaging = new Float32Array(DOT_TOTAL_VERTICES * POLY_VERTEX_FLOATS);
    private readonly polygonIndexData = new Uint16Array(MAX_VOICES + 1);

    // Out-param for consumeLatestFrame; one shared instance per module,
    // not per voice.
    private readonly formantsOut: FormantFrame = {
        f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0,
        rmsDb: 0, fundamentalHz: 0, confidence: 0,
    };

    // Pre-allocated polar-sort scratch. Filled each frame with indices
    // into the voices-that-have-published list, then handed to
    // OrderDebounce.update(). V8 keeps the internal capacity above the
    // high-water mark after the initial push-to-MAX_VOICES priming in
    // init(), so the reset + push pattern below is zero-alloc in
    // steady state.
    private readonly orderingScratch = new Int32Array(MAX_VOICES);
    // Caller-supplied scratch for polarAngleSortInto's precomputed
    // angles. Float64Array because Math.atan2 returns f64 and we want
    // to preserve that precision through the comparator.
    private readonly anglesScratch = new Float64Array(MAX_VOICES);
    private readonly orderDebounce = new OrderDebounce();

    // pointsScratch: pre-allocated VoicePoint[] primed to MAX_VOICES
    // capacity at init time. Reset via length=0 + push per frame; V8
    // keeps allocated capacity at high-water mark so push never
    // reallocates. This avoids a per-frame new Array<VoicePoint>().
    private readonly pointsScratch: VoicePoint[] = [];

    private voices: ReadonlyArray<VoiceEntry> = [];
    private readonly channels = new Map<string, VoiceState>();
    private cssWidth = 0;
    private cssHeight = 0;
    private dpr = 1;
    // Count of voices with hasEverPublished=true on the most recent
    // update(). Controls draw() early-exit and indexed draw count.
    private currentVoiceCount = 0;

    public init(device: GPUDevice, queue: GPUQueue): void {
        this.device = device;
        this.queue = queue;

        // Prime pointsScratch capacity so subsequent push() calls never
        // grow the internal array. Length is reset to 0 each frame;
        // capacity stays at MAX_VOICES.
        for (let i = 0; i < MAX_VOICES; i++) {
            this.pointsScratch.push({
                channelId: '',
                color: '',
                f1Hz: 0,
                f2Hz: 0,
                isDimmed: true,
                hasEverPublished: false,
            });
        }
        this.pointsScratch.length = 0;

        const bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {type: 'uniform'}},
            ],
        });

        const pipelineLayout = device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]});

        const shaderModule = device.createShaderModule({code: VOWEL_SHADER_WGSL});

        // Vertex buffer layout: position (f32x2) at offset 0, color
        // (f32x4) at offset 8. Stride = 24 bytes = POLY_VERTEX_BYTES.
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: POLY_VERTEX_BYTES,
            attributes: [
                {shaderLocation: 0, offset: 0, format: 'float32x2'},
                {shaderLocation: 1, offset: 8, format: 'float32x4'},
            ],
        };

        // Polygon pipeline: line-strip + index buffer for closed-loop
        // draw. WebGPU line-strip has no built-in primitive restart, so
        // the loop closure is encoded as an extra index (vertex[N] =
        // vertex[0]) in the index buffer, and drawIndexed(N+1) traces
        // from vertex 0 to vertex N-1 to vertex 0.
        //
        // createRenderPipeline (sync) rather than createRenderPipelineAsync:
        // the interface contract requires init() to be sync. Pipeline
        // compile cost is paid once on first draw; acceptable because
        // this is not a smoothness-measurement path (the alloc test
        // warms up 200 frames before the measurement window begins).
        this.polygonPipeline = device.createRenderPipeline({
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
                    format: navigator.gpu.getPreferredCanvasFormat(),
                    blend: {
                        color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'},
                        alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
                    },
                }],
            },
            primitive: {topology: 'line-strip'},
        });

        // Dot pipeline: triangle-list (two triangles = square dot).
        this.dotPipeline = device.createRenderPipeline({
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
                    format: navigator.gpu.getPreferredCanvasFormat(),
                    blend: {
                        color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'},
                        alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
                    },
                }],
            },
            primitive: {topology: 'triangle-list'},
        });

        // GPU buffers.
        this.viewportUniform = device.createBuffer({
            size: VIEWPORT_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // +1 vertex for the loop-close repeated vertex.
        this.polygonVertexBuffer = device.createBuffer({
            size: (MAX_VOICES + 1) * POLY_VERTEX_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        // +1 index for the loop-close reference.
        this.polygonIndexBuffer = device.createBuffer({
            size: (MAX_VOICES + 1) * 2, // Uint16 = 2 bytes each
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });

        this.dotVertexBuffer = device.createBuffer({
            size: DOT_TOTAL_VERTICES * POLY_VERTEX_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        this.bindGroup = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [{binding: 0, resource: {buffer: this.viewportUniform}}],
        });
    }

    public update(dtMs: number): void {
        if (!this.device || !this.queue || !this.polygonPipeline || this.cssHeight === 0) {
            return;
        }

        // Update viewport uniform (width, height, dpr, pad).
        this.viewportData[0] = this.cssWidth;
        this.viewportData[1] = this.cssHeight;
        this.viewportData[2] = this.dpr;
        this.viewportData[3] = 0;
        this.queue.writeBuffer(this.viewportUniform!, 0, this.viewportData);

        // Collect published voice points. pointsScratch is pre-allocated;
        // reset to length 0 each frame then push up to MAX_VOICES entries.
        this.pointsScratch.length = 0;
        for (const voice of this.voices) {
            const state = this.channels.get(voice.channelId);
            if (!state) {
                continue;
            }
            consumeLatestFrame(state.point, state.reader, this.formantsOut, state.debounce, dtMs);
            if (state.point.hasEverPublished) {
                this.pointsScratch.push(state.point);
            }
        }
        const voiceCount = this.pointsScratch.length;
        this.currentVoiceCount = voiceCount;

        if (voiceCount === 0) {
            return;
        }

        // Compute polar-angle ordering into orderingScratch via the
        // shared zero-alloc helper from vowelModule.ts. Sharing the
        // sort with the unit-tested polarAngleSort wrapper keeps the
        // tie-break behaviour identical between the unit suite and
        // the runtime paint path; an inline sort would be a divergence
        // surface no test covers.
        polarAngleSortInto(this.pointsScratch, voiceCount, this.anglesScratch, this.orderingScratch);

        // Apply ordering debounce.
        this.orderDebounce.update(this.orderingScratch, voiceCount, dtMs);
        const applied = this.orderDebounce.getApplied();
        const appliedLen = this.orderDebounce.getAppliedLength();

        // Build polygon vertex staging. Vertex layout: (xNdc, yNdc, r,
        // g, b, a). NDC mapping (IPA-inverted axes):
        //   xNdc = 1 - 2*(f2Hz - F2_MIN)/F2_SPAN  (high F2 = front = left)
        //   yNdc = 1 - 2*(f1Hz - F1_MIN)/F1_SPAN  (high F1 = open = bottom)
        const polySt = this.polygonStaging;
        for (let i = 0; i < appliedLen; i++) {
            const pt = this.pointsScratch[applied[i]];
            const base = i * POLY_VERTEX_FLOATS;
            polySt[base]     = 1 - 2 * (pt.f2Hz - F2_MIN) / F2_SPAN;
            polySt[base + 1] = 1 - 2 * (pt.f1Hz - F1_MIN) / F1_SPAN;
            // Color: full or dimmed based on gate state.
            const state = this.channels.get(pt.channelId)!;
            const col = pt.isDimmed ? state.dimColor : state.fullColor;
            polySt[base + 2] = col[0];
            polySt[base + 3] = col[1];
            polySt[base + 4] = col[2];
            polySt[base + 5] = col[3];
        }
        // Copy vertex 0 after the last vertex to close the loop.
        const closeBase = appliedLen * POLY_VERTEX_FLOATS;
        const v0Base = 0;
        for (let k = 0; k < POLY_VERTEX_FLOATS; k++) {
            polySt[closeBase + k] = polySt[v0Base + k];
        }

        // Index buffer: [0, 1, ..., N-1, 0] for closed-loop line-strip.
        for (let i = 0; i < appliedLen; i++) {
            this.polygonIndexData[i] = i;
        }
        this.polygonIndexData[appliedLen] = 0;

        this.queue.writeBuffer(
            this.polygonVertexBuffer!,
            0,
            polySt.buffer,
            polySt.byteOffset,
            (appliedLen + 1) * POLY_VERTEX_BYTES,
        );
        // WebGPU requires writeBuffer size to be a multiple of 4.
        // Round up the Uint16 index count to the nearest 4-byte boundary.
        const indexWriteBytes = Math.ceil(((appliedLen + 1) * 2) / 4) * 4;
        this.queue.writeBuffer(
            this.polygonIndexBuffer!,
            0,
            this.polygonIndexData.buffer,
            this.polygonIndexData.byteOffset,
            indexWriteBytes,
        );

        // Build dot vertex staging. For each voice, two triangles form a
        // square at the dot's NDC position. The square's half-side in NDC
        // is derived from the dot CSS size: half = VOWEL_DOT_CSS_SIZE * dpr / 2
        // in device pixels, then mapped to NDC via 2/canvasWidth (x) and
        // 2/canvasHeight (y). Uses roster order (not applied polar order)
        // so dot indices stay stable across ordering debounce transitions.
        const dw = this.cssWidth * this.dpr;
        const dh = this.cssHeight * this.dpr;
        const dotPxHalf = Math.round(VOWEL_DOT_CSS_SIZE * this.dpr) / 2;
        const hx = dw > 0 ? dotPxHalf / (dw / 2) : 0; // half-side in NDC x
        const hy = dh > 0 ? dotPxHalf / (dh / 2) : 0; // half-side in NDC y
        const dotSt = this.dotStaging;
        let dotVertIdx = 0;
        for (let vi = 0; vi < voiceCount; vi++) {
            const pt = this.pointsScratch[vi];
            const state = this.channels.get(pt.channelId)!;
            const col = pt.isDimmed ? state.dimColor : state.fullColor;
            const cx = 1 - 2 * (pt.f2Hz - F2_MIN) / F2_SPAN;
            const cy = 1 - 2 * (pt.f1Hz - F1_MIN) / F1_SPAN;
            const r = col[0];
            const g = col[1];
            const b = col[2];
            const a = col[3];
            // Triangle 1: top-left, top-right, bottom-left
            // Triangle 2: top-right, bottom-right, bottom-left
            const x0 = cx - hx;
            const x1 = cx + hx;
            const y0 = cy - hy;
            const y1 = cy + hy;
            const base = dotVertIdx * POLY_VERTEX_FLOATS;
            // v0: top-left
            dotSt[base]      = x0; dotSt[base + 1]  = y0; dotSt[base + 2]  = r; dotSt[base + 3]  = g; dotSt[base + 4]  = b; dotSt[base + 5]  = a;
            // v1: top-right
            dotSt[base + 6]  = x1; dotSt[base + 7]  = y0; dotSt[base + 8]  = r; dotSt[base + 9]  = g; dotSt[base + 10] = b; dotSt[base + 11] = a;
            // v2: bottom-left
            dotSt[base + 12] = x0; dotSt[base + 13] = y1; dotSt[base + 14] = r; dotSt[base + 15] = g; dotSt[base + 16] = b; dotSt[base + 17] = a;
            // v3: top-right (repeat)
            dotSt[base + 18] = x1; dotSt[base + 19] = y0; dotSt[base + 20] = r; dotSt[base + 21] = g; dotSt[base + 22] = b; dotSt[base + 23] = a;
            // v4: bottom-right
            dotSt[base + 24] = x1; dotSt[base + 25] = y1; dotSt[base + 26] = r; dotSt[base + 27] = g; dotSt[base + 28] = b; dotSt[base + 29] = a;
            // v5: bottom-left (repeat)
            dotSt[base + 30] = x0; dotSt[base + 31] = y1; dotSt[base + 32] = r; dotSt[base + 33] = g; dotSt[base + 34] = b; dotSt[base + 35] = a;
            dotVertIdx += DOT_VERTICES_PER_VOICE;
        }

        if (dotVertIdx > 0) {
            this.queue.writeBuffer(
                this.dotVertexBuffer!,
                0,
                dotSt.buffer,
                dotSt.byteOffset,
                dotVertIdx * POLY_VERTEX_BYTES,
            );
        }
    }

    public draw(passEncoder: GPURenderPassEncoder): void {
        if (!this.polygonPipeline || !this.dotPipeline || !this.bindGroup) {
            return;
        }
        if (this.currentVoiceCount === 0) {
            return;
        }
        passEncoder.setBindGroup(0, this.bindGroup);

        // Polygon line-strip (skip for fewer than 2 voices; a single
        // vertex line-strip is a no-op, and 0 voices is caught above).
        const appliedLen = this.orderDebounce.getAppliedLength();
        if (appliedLen >= 2) {
            passEncoder.setPipeline(this.polygonPipeline);
            passEncoder.setVertexBuffer(0, this.polygonVertexBuffer!);
            passEncoder.setIndexBuffer(this.polygonIndexBuffer!, 'uint16');
            passEncoder.drawIndexed(appliedLen + 1);
        }

        // Dots: one square (2 triangles = 6 vertices) per voice.
        passEncoder.setPipeline(this.dotPipeline);
        passEncoder.setVertexBuffer(0, this.dotVertexBuffer!);
        passEncoder.draw(this.currentVoiceCount * DOT_VERTICES_PER_VOICE);
    }

    public dispose(): void {
        this.polygonVertexBuffer?.destroy();
        this.polygonIndexBuffer?.destroy();
        this.dotVertexBuffer?.destroy();
        this.viewportUniform?.destroy();
        this.polygonVertexBuffer = null;
        this.polygonIndexBuffer = null;
        this.dotVertexBuffer = null;
        this.viewportUniform = null;
        this.polygonPipeline = null;
        this.dotPipeline = null;
        this.device = null;
        this.queue = null;
        this.channels.clear();
        this.orderDebounce.reset();
        this.pointsScratch.length = 0;
        this.currentVoiceCount = 0;
    }

    // Lifecycle methods called by Task 12's worker dispatch.

    public setBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        this.cssWidth = cssWidth;
        this.cssHeight = cssHeight;
        this.dpr = dpr;
    }

    public setRoster(voices: ReadonlyArray<VoiceEntry>): void {
        this.voices = voices;
        for (const voice of voices) {
            const state = this.channels.get(voice.channelId);
            if (!state) {
                continue;
            }
            state.color = voice.color;
            hexToRgba(voice.color, state.fullColor);
            for (let i = 0; i < 3; i++) {
                state.dimColor[i] = state.fullColor[i] * VOWEL_DIM_BRIGHTNESS;
            }
            state.dimColor[3] = 1;
        }
    }

    public attachVoice(channelId: string, color: string, reader: FrameRingReader): void {
        if (this.channels.has(channelId)) {
            return;
        }
        const fullColor = new Float32Array(4);
        const dimColor = new Float32Array(4);
        try {
            hexToRgba(color, fullColor);
        }
        catch {
            // Fall back to white if the color is unparseable (should not
            // happen for SLOT_COLORS, but the failure mode is a transient
            // render glitch, not a crash).
            fullColor[0] = 1; fullColor[1] = 1; fullColor[2] = 1; fullColor[3] = 1;
        }
        for (let i = 0; i < 3; i++) {
            dimColor[i] = fullColor[i] * VOWEL_DIM_BRIGHTNESS;
        }
        dimColor[3] = 1;

        this.channels.set(channelId, {
            channelId,
            color,
            reader,
            point: {
                channelId,
                color,
                f1Hz: 0,
                f2Hz: 0,
                isDimmed: true,
                hasEverPublished: false,
            },
            debounce: new GateDebounce(),
            fullColor,
            dimColor,
        });
        // Roster change forces re-debounce of polar ordering.
        this.orderDebounce.reset();
    }

    public detachVoice(channelId: string): void {
        this.channels.delete(channelId);
        this.orderDebounce.reset();
    }

    public rebaseVoice(channelId: string, epochOffsetMs: number): void {
        this.channels.get(channelId)?.reader.setOffset(epochOffsetMs);
    }
}

// ===== WGSL shader source =====
//
// Single combined module for vertex + fragment. Position is f32x2 at
// @location(0); color is f32x4 at @location(1). Stride = 24 bytes.
// The viewport uniform binding is present for future use (e.g., NDC
// jitter / pixel-snapping in a follow-up thick-line pass); in this
// slice the vertex shader passes position through unchanged because
// the CPU side already computes NDC coordinates directly.

const VOWEL_SHADER_WGSL = /* wgsl */`
struct Viewport {
    widthPx: f32,
    heightPx: f32,
    dpr: f32,
    _pad: f32,
};

@group(0) @binding(0)
var<uniform> viewport: Viewport;

struct VsIn {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
};

struct VsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VsIn) -> VsOut {
    var out: VsOut;
    out.position = vec4<f32>(input.position, 0.0, 1.0);
    out.color = input.color;
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
