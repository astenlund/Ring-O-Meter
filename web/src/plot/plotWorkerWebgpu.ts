/// <reference lib="webworker" />

import {FrameRingReader} from '../audio/frameRing';
import {
    PlotMessageType,
    type InitVowelCanvasMessage,
    type PlotMessage,
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

        vowelModule = new VowelModuleWebgpu();
        vowelModule.init(device, queue, format);
        vowelModule.setBacking(msg.backing.cssWidth, msg.backing.cssHeight, msg.backing.dpr);
        vowelInitialised = true;

        for (const queued of pendingVowelMessages) {
            applyMessage(queued);
        }
        pendingVowelMessages.length = 0;
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
            renderer.setRoster(msg.voices);

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
            vowelModule!.setBacking(msg.cssWidth, msg.cssHeight, msg.dpr);

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
