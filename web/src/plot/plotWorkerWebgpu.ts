/// <reference lib="webworker" />

import {FrameRingReader} from '../audio/frameRing';
import {
    PlotMessageType,
    type InitVowelCanvasMessage,
    type PlotMessage,
    type VoiceEntry,
} from './plotMessages';
import {TraceModule} from './traceModule';
import {VowelModuleWebgpu} from './vowelModuleWebgpu';

// Top-level: kick off device acquisition as soon as the worker module
// loads. Both Init (trace canvas) and InitVowelCanvas await this; the
// canvas-handling code on each side configures its own GPUCanvasContext
// against the resolved device. Keeps message-arrival order independent
// from device readiness, which matters under React 19 StrictMode where
// sibling-effect order between PitchPlot and VowelPlot is not stable.
interface ResolvedDevice {
    device: GPUDevice;
    queue: GPUQueue;
    format: GPUTextureFormat;
}

const devicePromise: Promise<ResolvedDevice> = (async () => {
    if (!navigator.gpu) {
        throw new Error('plotWorkerWebgpu: navigator.gpu unavailable');
    }
    const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
    if (!adapter) {
        throw new Error('plotWorkerWebgpu: no GPU adapter');
    }
    const device = await adapter.requestDevice();

    return {device, queue: device.queue, format: navigator.gpu.getPreferredCanvasFormat()};
})();

const renderer = new TraceModule();
let initialised = false;
let initFailed = false;
const pendingMessages: PlotMessage[] = [];
let rafId = 0;

// Vowel-side state.
let vowelModule: VowelModuleWebgpu | null = null;
let vowelCanvasContext: GPUCanvasContext | null = null;
const pendingVowelMessages: PlotMessage[] = [];
let vowelInitialised = false;
// Captured once initVowelCanvas resolves devicePromise so subsequent
// SetVowelBacking handlers can resize+reconfigure the GPUCanvasContext
// without re-awaiting the device. The trace's TraceModule does its own
// resize internally; the vowel side's host-owned context model needs
// these to match the reconfigure shape across canvas size changes
// (Safari/iPadOS WebKit doesn't auto-reconfigure on canvas resize).
let resolvedVowelDevice: GPUDevice | null = null;
let resolvedVowelFormat: GPUTextureFormat | null = null;

// Most-recent roster, updated by both Init and SetRoster handlers.
// initVowelCanvas seeds vowelModule.setRoster(lastVoices) on creation
// to cover the timing window where SetRoster arrives during the async
// initVowelCanvas await: the trace renderer is constructed at module
// load and receives setRoster directly, but vowelModule is created
// inside the async path, so any SetRoster that arrives during the
// await silently skips the vowel fanout (the `if (vowelModule)` guard
// sees null). Without seeding, the vowel module's `voices` stays empty
// and update() iterates an empty list, producing zero points.
let lastVoices: ReadonlyArray<VoiceEntry> = [];

// Resize the vowel canvas + reconfigure the GPU context + propagate
// dims to the module. Called from initVowelCanvas (after the initial
// configure) and from the SetVowelBacking dispatch (every backing
// update, including the post-mount transition from placeholder 0x0
// to real CSS dimensions). Cross-platform-parity rationale matches
// TraceModule.setBacking: reconfigure unconditionally on every actual
// resize so Safari/iPadOS WebKit doesn't paint to a stale swap-chain.
// Tracks the most-recent applied dpr so a DPR-only change (same CSS
// dimensions, different device-pixel-ratio - hot-plugging a HiDPI
// monitor, OS scale change) still triggers a swap-chain reconfigure.
// The pixel-dimension guard alone would skip that case, leaving the
// vowel canvas painting to a stale-DPR backing while the trace canvas
// (TraceModule.setBacking reconfigures unconditionally) updates.
// `lastDpr` lives in the function's closure so it cannot accidentally
// be touched by sibling message handlers; only this function reads
// and writes it.
const applyVowelCanvasBacking = ((): (cssWidth: number, cssHeight: number, dpr: number) => void => {
    let lastDpr = 0;

    return (cssWidth: number, cssHeight: number, dpr: number): void => {
        if (!vowelModule) {
            return;
        }
        vowelModule.setBacking(cssWidth, cssHeight, dpr);
        if (cssWidth === 0 || cssHeight === 0 || !vowelCanvasContext || !resolvedVowelDevice || !resolvedVowelFormat) {
            return;
        }
        const canvas = vowelCanvasContext.canvas as OffscreenCanvas;
        const w = Math.round(cssWidth * dpr);
        const h = Math.round(cssHeight * dpr);
        if (canvas.width !== w || canvas.height !== h || dpr !== lastDpr) {
            canvas.width = w;
            canvas.height = h;
            vowelCanvasContext.configure({
                device: resolvedVowelDevice,
                format: resolvedVowelFormat,
                alphaMode: 'premultiplied',
            });
            lastDpr = dpr;
        }
    };
})();

// Initialised lazily on the first frame: a literal 0 baseline would
// produce a multi-million-ms first-frame dt (rAF stamps wall-clock
// since navigation start), which is harmless for the trace's update()
// (it ignores dtMs) but would instantly satisfy GATE_DEBOUNCE_MS and
// ORDER_DEBOUNCE_MS on the vowel module's first paint, defeating the
// debounce on frame 1.
let lastFrameMs = 0;

function frame(nowMs: number): void {
    const dtMs = lastFrameMs === 0 ? 0 : nowMs - lastFrameMs;
    lastFrameMs = nowMs;

    renderer.update(dtMs);
    if (vowelModule) {
        vowelModule.update(dtMs);
    }

    const device = renderer.gpuDevice;
    const traceContext = renderer.gpuContext;
    const traceReady = device && traceContext && renderer.canRender();
    const vowelReady = device && vowelCanvasContext && vowelModule;

    if (!traceReady && !vowelReady) {
        rafId = requestAnimationFrame(frame);

        return;
    }

    const encoder = device!.createCommandEncoder();

    // Trace pass on the trace canvas.
    if (traceReady) {
        const tracePass = encoder.beginRenderPass({
            colorAttachments: [{
                view: traceContext!.getCurrentTexture().createView(),
                // Transparent clear so the underlay (grid + legend)
                // shows through. Trace pixels are written by the
                // fragment shader with alpha = 1.
                clearValue: {r: 0, g: 0, b: 0, a: 0},
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        renderer.draw(tracePass);
        tracePass.end();
    }

    // Vowel pass on the vowel canvas.
    if (vowelReady) {
        const vowelPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: vowelCanvasContext!.getCurrentTexture().createView(),
                clearValue: {r: 0, g: 0, b: 0, a: 0},
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });
        vowelModule!.draw(vowelPass);
        vowelPass.end();
    }

    device!.queue.submit([encoder.finish()]);

    rafId = requestAnimationFrame(frame);
}

async function initVowelCanvas(msg: InitVowelCanvasMessage): Promise<void> {
    try {
        const {device, queue, format} = await devicePromise;
        const ctx = msg.canvas.getContext('webgpu') as GPUCanvasContext | null;
        if (!ctx) {
            throw new Error('plotWorkerWebgpu: webgpu context unavailable for vowel canvas');
        }
        // alphaMode: 'premultiplied' so the vowel chrome (painted on a
        // sibling main-thread underlay canvas in Task 14) shows through
        // pixels the polygon/dot fragment shader does not write.
        ctx.configure({device, format, alphaMode: 'premultiplied'});
        vowelCanvasContext = ctx;
        resolvedVowelDevice = device;
        resolvedVowelFormat = format;

        vowelModule = new VowelModuleWebgpu();
        vowelModule.init(device, queue, format);
        // Seed the vowel module's roster from the most-recent SetRoster
        // (or Init) the worker has seen. Covers the timing window where
        // SetRoster arrives during this initVowelCanvas await: the
        // SetRoster handler's `if (vowelModule)` guard silently skipped
        // the fanout because vowelModule was still null. Without this
        // seeding, vowelModule.voices stays empty and update() produces
        // zero points even when channels are attached.
        vowelModule.setRoster(lastVoices);
        // applyVowelCanvasBacking handles canvas resize + context
        // reconfigure when the initial backing has real CSS dims; with
        // a 0x0 placeholder it just propagates dims to the module
        // (which early-exits its update loop until real dims arrive
        // via SetVowelBacking).
        applyVowelCanvasBacking(msg.backing.cssWidth, msg.backing.cssHeight, msg.backing.dpr);
        vowelInitialised = true;

        for (const queued of pendingVowelMessages) {
            applyMessage(queued);
        }
        pendingVowelMessages.length = 0;

        // Arm rAF here so a vowel-only mount (no PitchPlot) still
        // paints. The trace's Init handler also arms; the guard
        // ensures only one arming per worker lifetime.
        if (rafId === 0 && msg.backing.cssHeight > 0) {
            rafId = requestAnimationFrame(frame);
        }
    } catch (err) {
        self.postMessage({
            type: 'vowelInitError',
            message: err instanceof Error ? err.message : String(err),
        });
    }
}

function applyMessage(msg: PlotMessage): void {
    switch (msg.type) {
        case PlotMessageType.Init: {
            // Init is the first message; handled inline in onmessage before
            // any other message runs. Should never reach here.
            return;
        }
        case PlotMessageType.SetRoster: {
            lastVoices = msg.voices;
            renderer.setRoster(msg.voices);
            if (vowelModule) {
                vowelModule.setRoster(msg.voices);
            }

            return;
        }
        case PlotMessageType.SetBacking: {
            renderer.setBacking(msg.cssWidth, msg.cssHeight, msg.dpr);
            if (rafId === 0 && msg.cssHeight > 0) {
                rafId = requestAnimationFrame(frame);
            }

            return;
        }
        case PlotMessageType.AttachChannel: {
            renderer.attachChannel(msg.channelId, msg.source);

            return;
        }
        case PlotMessageType.DetachChannel: {
            renderer.detachChannel(msg.channelId);

            return;
        }
        case PlotMessageType.RebaseChannel: {
            renderer.rebaseChannel(msg.channelId, msg.epochOffsetMs);

            return;
        }
        case PlotMessageType.InitVowelCanvas: {
            void initVowelCanvas(msg);

            return;
        }
        case PlotMessageType.AttachVowelChannel: {
            if (!vowelInitialised) {
                pendingVowelMessages.push(msg);

                return;
            }
            vowelModule!.attachVoice(msg.channelId, msg.color, new FrameRingReader(msg.source.sab, msg.source.epochOffsetMs));

            return;
        }
        case PlotMessageType.DetachVowelChannel: {
            if (!vowelInitialised) {
                // No-op against an uninitialized vowel module; deferring would
                // be wrong because the channel was never attached to begin with.
                return;
            }
            vowelModule!.detachVoice(msg.channelId);

            return;
        }
        case PlotMessageType.RebaseVowelChannel: {
            if (!vowelInitialised) {
                pendingVowelMessages.push(msg);

                return;
            }
            vowelModule!.rebaseVoice(msg.channelId, msg.epochOffsetMs);

            return;
        }
        case PlotMessageType.SetVowelBacking: {
            if (!vowelInitialised) {
                pendingVowelMessages.push(msg);

                return;
            }
            // Resize the OffscreenCanvas + reconfigure the GPU context
            // when CSS dimensions change. Without this the canvas stays
            // at its initial size (typically 0x0 because VowelPlot's
            // mount effect runs before useCanvasBacking has settled) and
            // getCurrentTexture returns an empty texture - the polygon
            // pass succeeds but produces nothing visible.
            applyVowelCanvasBacking(msg.cssWidth, msg.cssHeight, msg.dpr);
            // Arm rAF if a vowel-only mount has not started painting
            // yet (the trace's SetBacking handler also arms; idempotent).
            if (rafId === 0 && msg.cssHeight > 0) {
                rafId = requestAnimationFrame(frame);
            }

            return;
        }
        default: {
            const _exhaustive: never = msg;
            void _exhaustive;
        }
    }
}

self.onmessage = async (event: MessageEvent<PlotMessage>) => {
    const msg = event.data;
    if (initFailed) {
        // Init failed once; further messages would just leak SAB
        // descriptors into the pendingMessages array forever. Drop
        // them silently - main has already been notified via the
        // 'webgpuInitError' message posted below.
        return;
    }
    if (!initialised && msg.type === PlotMessageType.Init) {
        try {
            const {device, format} = await devicePromise;
            const mainEpochOffsetMs = msg.mainNowAtInitMs - performance.now();
            renderer.setEpochOffset(mainEpochOffsetMs);
            lastVoices = msg.voices;
            renderer.setRoster(msg.voices);
            renderer.setWindow(msg.windowMs, msg.minHz, msg.maxHz);
            await renderer.init(msg.canvas, device, format);
        } catch (err) {
            initFailed = true;
            pendingMessages.length = 0;
            // Surface the failure to main as a structured-cloneable
            // payload. App.tsx can register a worker.onmessage handler
            // that logs and optionally renders a "WebGPU unavailable"
            // banner; for the prototype, console-level surfacing is
            // sufficient and the parameterized e2e's adapter
            // precondition catches most failure modes before paint
            // starts.
            self.postMessage({
                type: 'webgpuInitError',
                message: err instanceof Error ? err.message : String(err),
            });

            return;
        }
        renderer.setBacking(msg.backing.cssWidth, msg.backing.cssHeight, msg.backing.dpr);
        initialised = true;
        for (const queued of pendingMessages) {
            applyMessage(queued);
        }
        pendingMessages.length = 0;
        if (rafId === 0 && msg.backing.cssHeight > 0) {
            rafId = requestAnimationFrame(frame);
        }

        return;
    }
    if (!initialised) {
        pendingMessages.push(msg);

        return;
    }
    applyMessage(msg);
};
