import {CAPACITY, FrameRingReader, type FrameSource} from '../audio/frameRing';
import {shouldDisplayPitch} from '../ui/displayGate';
import type {VoiceEntry} from './plotMessages';
import {FRAGMENT_WGSL, VERTEX_WGSL} from './webgpuShaders';

const VERTEX_BYTES = 8;
// line-list topology: each segment is encoded as 2 explicit vertices
// (no strip connectivity), so the worst-case vertex count is
// 2 * (CAPACITY - 1) for CAPACITY consecutive valid samples. Bound at
// 2 * CAPACITY for clean alignment; the extra 2 vertices are unused
// padding.
const MAX_VERTEX_COUNT = CAPACITY * 2;
const VERTEX_BUFFER_BYTES = MAX_VERTEX_COUNT * VERTEX_BYTES;
const STAGING_FLOAT_COUNT = MAX_VERTEX_COUNT * 2;
const VIEWPORT_UNIFORM_BYTES = 16;
const VOICE_UNIFORM_BYTES = 16;

interface ChannelState {
    reader: FrameRingReader;
    vertexBuffer: GPUBuffer;
    voiceUniform: GPUBuffer;
    bindGroup: GPUBindGroup;
    // Hoisted CPU staging: filled per paint by walking the ring's
    // in-window samples and emitting a (prev, curr) segment whenever
    // two consecutive samples both pass the display gate. Sized for
    // the worst case (every ring slot in window, all pass gate).
    staging: Float32Array;
    vertexCount: number;
    color: Float32Array;
}

export class WebgpuPlotRenderer {
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private format: GPUTextureFormat | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private viewportUniform: GPUBuffer | null = null;
    private viewportData: Float32Array = new Float32Array(4);
    private bindGroupLayout: GPUBindGroupLayout | null = null;
    private channels = new Map<string, ChannelState>();
    private voices: ReadonlyArray<VoiceEntry> = [];
    private windowMs = 10_000;
    private logMinHz = Math.log(80);
    private logSpanHz = Math.log(600) - Math.log(80);
    private mainEpochOffsetMs = 0;
    // Tracked so paint() can early-exit before the canvas has a real
    // CSS size (matches plotWorker.ts:79 cssHeight gate). cssWidth and
    // dpr aren't kept as fields because nothing else reads them; the
    // backing-store sizing in setBacking writes the canvas dimensions
    // directly.
    private cssHeight = 0;

    public async init(canvas: OffscreenCanvas): Promise<void> {
        if (!navigator.gpu) {
            throw new Error('WebgpuPlotRenderer: navigator.gpu unavailable');
        }
        const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
        if (!adapter) {
            throw new Error('WebgpuPlotRenderer: no GPU adapter');
        }
        const device = await adapter.requestDevice();
        // OffscreenCanvas.getContext('webgpu') is typed as the broader
        // OffscreenRenderingContext union (TS 6's lib.webworker.d.ts has
        // overloads only for "2d" / "bitmaprenderer" / "webgl" /
        // "webgl2"; the "webgpu" string falls through to the generic
        // overload). Cast to GPUCanvasContext explicitly so the rest of
        // this method can call configure() / getCurrentTexture() against
        // the GPU-specific shape.
        const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
        if (!context) {
            throw new Error('WebgpuPlotRenderer: webgpu context unavailable');
        }
        const format = navigator.gpu.getPreferredCanvasFormat();
        // Deliberately do NOT configure the context here. The
        // OffscreenCanvas dimensions at this point reflect the
        // pre-layout state of the source canvas (often 0x0 or 300x150
        // default), and configure() against those produces a
        // "texture size empty" validation warning when the first
        // getCurrentTexture() runs. setBacking() owns the configure
        // call, gated on real CSS dimensions arriving from the main
        // thread. paint() guards against pre-configure invocation by
        // checking cssHeight === 0 below.

        const bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {binding: 0, visibility: GPUShaderStage.VERTEX, buffer: {type: 'uniform'}},
                {binding: 1, visibility: GPUShaderStage.VERTEX, buffer: {type: 'uniform'}},
            ],
        });

        const pipelineLayout = device.createPipelineLayout({bindGroupLayouts: [bindGroupLayout]});
        const vsModule = device.createShaderModule({code: VERTEX_WGSL});
        const fsModule = device.createShaderModule({code: FRAGMENT_WGSL});
        // createRenderPipelineAsync - not the synchronous variant -
        // because WebGPU's spec allows synchronous createRenderPipeline
        // to defer actual GPU compilation, with the cost surfacing on
        // first draw call. The spec's "Cold-start judder bounded to
        // sub-second" success criterion needs compilation to complete
        // before init() resolves; the async variant resolves only after
        // compilation is fully done. Worker init now genuinely pre-warms
        // the pipeline before paint() ever runs.
        const pipeline = await device.createRenderPipelineAsync({
            layout: pipelineLayout,
            vertex: {
                module: vsModule,
                entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: VERTEX_BYTES,
                    attributes: [
                        {shaderLocation: 0, offset: 0, format: 'float32'},
                        {shaderLocation: 1, offset: 4, format: 'float32'},
                    ],
                }],
            },
            fragment: {
                module: fsModule,
                entryPoint: 'fs_main',
                targets: [{format}],
            },
            // line-list: each pair of vertices in the buffer forms one
            // independent segment. Avoids the multi-draw fan-out that
            // line-strip topology would force when the trace contains
            // gaps (silence between notes). Single draw call per
            // channel regardless of how staccato the input is.
            primitive: {topology: 'line-list'},
        });

        const viewportUniform = device.createBuffer({
            size: VIEWPORT_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.device = device;
        this.context = context;
        this.format = format;
        this.pipeline = pipeline;
        this.viewportUniform = viewportUniform;
        this.bindGroupLayout = bindGroupLayout;
    }

    public setRoster(voices: ReadonlyArray<VoiceEntry>): void {
        this.voices = voices;
        if (!this.device) {
            return;
        }
        for (const voice of voices) {
            const state = this.channels.get(voice.channelId);
            if (!state) {
                continue;
            }
            hexToRgba(voice.color, state.color);
            this.device.queue.writeBuffer(state.voiceUniform, 0, state.color);
        }
    }

    public attachChannel(channelId: string, source: FrameSource): void {
        if (!this.device || !this.bindGroupLayout || !this.viewportUniform) {
            throw new Error('attachChannel: renderer not initialised');
        }
        if (this.channels.has(channelId)) {
            return;
        }
        const reader = new FrameRingReader(source.sab, source.epochOffsetMs);
        const vertexBuffer = this.device.createBuffer({
            size: VERTEX_BUFFER_BYTES,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        const voiceUniform = this.device.createBuffer({
            size: VOICE_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                {binding: 0, resource: {buffer: this.viewportUniform}},
                {binding: 1, resource: {buffer: voiceUniform}},
            ],
        });

        const state: ChannelState = {
            reader,
            vertexBuffer,
            voiceUniform,
            bindGroup,
            staging: new Float32Array(STAGING_FLOAT_COUNT),
            vertexCount: 0,
            color: new Float32Array(4),
        };
        // Initialise the voice uniform with the channel's color from
        // the current roster. If the channel is not yet in the roster
        // (attach can race ahead of setRoster on first init), default
        // to white so traces are at least visible; the next setRoster
        // call refreshes uniforms.
        const voice = this.voices.find((v) => v.channelId === channelId);
        if (voice) {
            hexToRgba(voice.color, state.color);
        } else {
            state.color[0] = 1; state.color[1] = 1; state.color[2] = 1; state.color[3] = 1;
        }
        this.device.queue.writeBuffer(voiceUniform, 0, state.color);

        this.channels.set(channelId, state);
    }

    public detachChannel(channelId: string): void {
        const state = this.channels.get(channelId);
        if (!state) {
            return;
        }
        state.vertexBuffer.destroy();
        state.voiceUniform.destroy();
        this.channels.delete(channelId);
    }

    public rebaseChannel(channelId: string, epochOffsetMs: number): void {
        this.channels.get(channelId)?.reader.setOffset(epochOffsetMs);
    }

    public setWindow(windowMs: number, minHz: number, maxHz: number): void {
        this.windowMs = windowMs;
        this.logMinHz = Math.log(minHz);
        this.logSpanHz = Math.log(maxHz) - this.logMinHz;
    }

    public setEpochOffset(mainEpochOffsetMs: number): void {
        this.mainEpochOffsetMs = mainEpochOffsetMs;
    }

    public setBacking(cssWidth: number, cssHeight: number, dpr: number): void {
        this.cssHeight = cssHeight;
        if (!this.context || !this.device || !this.format) {
            return;
        }
        const canvas = this.context.canvas as OffscreenCanvas;
        const w = Math.round(cssWidth * dpr);
        const h = Math.round(cssHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            // After a canvas size change the swap-chain texture from
            // getCurrentTexture() is implementation-defined: Chrome's
            // Dawn backend auto-resizes, but Safari / iPadOS WebKit
            // requires an explicit reconfigure() call. CLAUDE.md's
            // cross-platform parity is a hard constraint, so we
            // reconfigure unconditionally on every actual resize. Cost
            // is negligible (resize is a cold path), and the call is
            // a no-op on backends that don't need it.
            // alphaMode: 'premultiplied' lets the WebGPU canvas pass
            // its alpha channel through to HTML composition. The clear
            // below uses (0,0,0,0) so non-trace pixels are fully
            // transparent and the static-element underlay (grid,
            // legend) renders behind. With alphaMode: 'opaque' the
            // GPU output is composited as solid (clearColor wins
            // everywhere), occluding the underlay entirely. The trace
            // fragment shader returns voice.color which is already
            // (R, G, B, 1) - that's correctly premultiplied for an
            // opaque trace pixel, so traces still render solid.
            this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: 'premultiplied',
            });
        }
    }

    public paint(): void {
        if (!this.device || !this.context || !this.pipeline || !this.viewportUniform) {
            return;
        }
        if (this.cssHeight === 0) {
            return;
        }
        const nowMs = performance.now() + this.mainEpochOffsetMs;
        const startMs = nowMs - this.windowMs;

        // Viewport struct is (windowMs, logMinHz, logSpanHz, _pad);
        // see webgpuShaders.ts for the shader-side definition and the
        // f32-precision rationale. Per-vertex offsetMs is computed on
        // the CPU below as `tsMs - startMs` so values stay in
        // [0, windowMs] before the f32 narrowing.
        this.viewportData[0] = this.windowMs;
        this.viewportData[1] = this.logMinHz;
        this.viewportData[2] = this.logSpanHz;
        this.viewportData[3] = 0;
        this.device.queue.writeBuffer(this.viewportUniform, 0, this.viewportData);

        // Channel-by-channel: fill staging with line-list segments,
        // upload. A segment is emitted whenever two consecutive
        // samples both pass the display gate AND both fall in-window;
        // gaps (silence, gate-failures, pre-window) cleanly skip
        // segment emission without any run-tracking bookkeeping.
        for (const voice of this.voices) {
            const state = this.channels.get(voice.channelId);
            if (!state) {
                continue;
            }
            const staging = state.staging;
            let vertexIdx = 0;
            let prevValid = false;
            let prevOffsetMs = 0;
            let prevHz = 0;

            state.reader.forEach(startMs, (tsMs, fundamentalHz, confidence) => {
                // Pre-window samples and gate-failures both invalidate
                // any pending pair; the next valid sample becomes a
                // fresh "prev" with no segment emitted from the prior.
                if (tsMs < startMs || !shouldDisplayPitch(fundamentalHz, confidence)) {
                    prevValid = false;

                    return;
                }
                // Store the per-paint offset (tsMs - startMs), not the
                // absolute tsMs, so the f32 narrowing at typed-array
                // assignment lands in [0, windowMs] rather than at
                // 10^6+ ms where f32 spacing is visible. See
                // webgpuShaders.ts for the rationale.
                const offsetMs = tsMs - startMs;
                if (prevValid) {
                    staging[vertexIdx * 2] = prevOffsetMs;
                    staging[vertexIdx * 2 + 1] = prevHz;
                    vertexIdx += 1;
                    staging[vertexIdx * 2] = offsetMs;
                    staging[vertexIdx * 2 + 1] = fundamentalHz;
                    vertexIdx += 1;
                }
                prevValid = true;
                prevOffsetMs = offsetMs;
                prevHz = fundamentalHz;
            });
            state.vertexCount = vertexIdx;

            if (vertexIdx > 0) {
                // writeBuffer with a typed-array view: no JS allocation;
                // bytes copied directly. The 4th/5th args constrain to
                // the populated prefix of staging.
                this.device.queue.writeBuffer(
                    state.vertexBuffer,
                    0,
                    staging.buffer,
                    staging.byteOffset,
                    vertexIdx * VERTEX_BYTES,
                );
            }
        }

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                // Transparent clear so the underlay (grid + legend)
                // shows through. Trace pixels are written by the
                // fragment shader with alpha = 1.
                clearValue: {r: 0, g: 0, b: 0, a: 0},
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(this.pipeline);
        for (const voice of this.voices) {
            const state = this.channels.get(voice.channelId);
            if (!state || state.vertexCount === 0) {
                continue;
            }
            pass.setBindGroup(0, state.bindGroup);
            pass.setVertexBuffer(0, state.vertexBuffer);
            // Single draw per channel regardless of staccato pattern;
            // line-list topology pairs vertices into independent
            // segments inside the buffer.
            pass.draw(state.vertexCount, 1, 0, 0);
        }
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    public dispose(): void {
        this.device?.destroy();
        this.device = null;
        this.channels.clear();
    }
}

// Parses VoiceEntry.color (e.g. '#5cf', '#fc5') into [r,g,b,1] floats
// in [0..1]. Supports 3-digit and 6-digit hex; does NOT handle named
// colors or rgb()/rgba() syntax (the codebase exclusively uses hex
// triples in SLOT_COLORS today). Throws on unsupported input rather
// than silently rendering black.
export function hexToRgba(hex: string, out: Float32Array): void {
    if (hex.length === 4 && hex[0] === '#') {
        const r = parseInt(hex[1] + hex[1], 16);
        const g = parseInt(hex[2] + hex[2], 16);
        const b = parseInt(hex[3] + hex[3], 16);
        out[0] = r / 255;
        out[1] = g / 255;
        out[2] = b / 255;
        out[3] = 1;

        return;
    }
    if (hex.length === 7 && hex[0] === '#') {
        out[0] = parseInt(hex.slice(1, 3), 16) / 255;
        out[1] = parseInt(hex.slice(3, 5), 16) / 255;
        out[2] = parseInt(hex.slice(5, 7), 16) / 255;
        out[3] = 1;

        return;
    }
    throw new Error(`hexToRgba: unsupported color ${hex}`);
}
