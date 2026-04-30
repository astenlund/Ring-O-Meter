import {CAPACITY, FrameRingReader, type FrameSource} from '../audio/frameRing';
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
    private cssWidth = 0;
    private cssHeight = 0;
    private dpr = 1;

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
        this.cssWidth = cssWidth;
        this.cssHeight = cssHeight;
        this.dpr = dpr;
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
