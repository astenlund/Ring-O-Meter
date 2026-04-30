import {CAPACITY, FrameRingReader, type FrameSource} from '../audio/frameRing';
import {shouldDisplayPitch} from '../ui/displayGate';
import type {VoiceEntry} from './plotMessages';
import {FRAGMENT_WGSL, VERTEX_WGSL} from './webgpuShaders';

const VERTEX_BYTES = 8;
const VERTEX_BUFFER_BYTES = CAPACITY * VERTEX_BYTES;
const VIEWPORT_UNIFORM_BYTES = 16;
const VOICE_UNIFORM_BYTES = 16;

interface ChannelState {
    reader: FrameRingReader;
    vertexBuffer: GPUBuffer;
    voiceUniform: GPUBuffer;
    bindGroup: GPUBindGroup;
    staging: Float32Array;
    runs: Int32Array;
    runCount: number;
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
        context.configure({device, format, alphaMode: 'opaque'});

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
            primitive: {topology: 'line-strip'},
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
            staging: new Float32Array(CAPACITY * 2),
            runs: new Int32Array(32),
            runCount: 0,
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
            this.context.configure({
                device: this.device,
                format: this.format,
                alphaMode: 'opaque',
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

        // Channel-by-channel: fill staging, track runs, upload.
        for (const voice of this.voices) {
            const state = this.channels.get(voice.channelId);
            if (!state) {
                continue;
            }
            const staging = state.staging;
            const runs = state.runs;
            let vertexIdx = 0;
            let runStart = -1;
            state.runCount = 0;

            state.reader.forEach(startMs, (tsMs, fundamentalHz, confidence) => {
                if (!shouldDisplayPitch(fundamentalHz, confidence)) {
                    if (runStart >= 0) {
                        // Close the open run. Single-vertex runs become
                        // degenerate (line-strip with one vertex draws
                        // nothing); two-or-more vertex runs draw. Cap
                        // at runs.length / 2 entries (each run is one
                        // [start,end) pair = 2 Int32 slots).
                        if (vertexIdx - runStart >= 2 && state.runCount < runs.length / 2) {
                            runs[state.runCount * 2] = runStart;
                            runs[state.runCount * 2 + 1] = vertexIdx;
                            state.runCount += 1;
                        }
                        runStart = -1;
                    }

                    return;
                }
                // Pre-window samples: skipped here because the WebGPU
                // viewport math already clips them off the left edge,
                // unlike the 2D path which interpolates a moveTo at
                // x=0. The prototype's spec ("Visual-feature parity ...
                // not a goal at this stage") tolerates the resulting
                // half-second gap at session start.
                if (tsMs < startMs) {
                    return;
                }
                // Store the per-paint offset (tsMs - startMs), not the
                // absolute tsMs, so the f32 narrowing at typed-array
                // assignment lands in [0, windowMs] rather than at
                // 10^6+ ms where f32 spacing is visible. See
                // webgpuShaders.ts for the rationale.
                staging[vertexIdx * 2] = tsMs - startMs;
                staging[vertexIdx * 2 + 1] = fundamentalHz;
                if (runStart < 0) {
                    runStart = vertexIdx;
                }
                vertexIdx += 1;
            });
            // Close a trailing open run.
            if (runStart >= 0 && vertexIdx - runStart >= 2 && state.runCount < runs.length / 2) {
                runs[state.runCount * 2] = runStart;
                runs[state.runCount * 2 + 1] = vertexIdx;
                state.runCount += 1;
            }

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
                clearValue: {r: 0x11 / 255, g: 0x11 / 255, b: 0x11 / 255, a: 1},
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        pass.setPipeline(this.pipeline);
        for (const voice of this.voices) {
            const state = this.channels.get(voice.channelId);
            if (!state || state.runCount === 0) {
                continue;
            }
            pass.setBindGroup(0, state.bindGroup);
            pass.setVertexBuffer(0, state.vertexBuffer);
            for (let r = 0; r < state.runCount; r += 1) {
                const start = state.runs[r * 2];
                const end = state.runs[r * 2 + 1];
                pass.draw(end - start, 1, start, 0);
            }
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
