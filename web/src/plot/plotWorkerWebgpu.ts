/// <reference lib="webworker" />

import {PlotMessageType, type PlotMessage} from './plotMessages';
import {TraceModule} from './traceModule';

const renderer = new TraceModule();
let initialised = false;
let initFailed = false;
const pendingMessages: PlotMessage[] = [];
let rafId = 0;

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

    const device = renderer.gpuDevice;
    const context = renderer.gpuContext;
    if (!device || !context || !renderer.canRender()) {
        rafId = requestAnimationFrame(frame);

        return;
    }

    const encoder = device.createCommandEncoder();
    const tracePass = encoder.beginRenderPass({
        colorAttachments: [{
            view: context.getCurrentTexture().createView(),
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

    device.queue.submit([encoder.finish()]);

    rafId = requestAnimationFrame(frame);
}

function applyMessage(msg: PlotMessage): void {
    switch (msg.type) {
        case PlotMessageType.Init: {
            // Init is the first message; handled inline below before
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
        const mainEpochOffsetMs = msg.mainNowAtInitMs - performance.now();
        renderer.setEpochOffset(mainEpochOffsetMs);
        renderer.setRoster(msg.voices);
        renderer.setWindow(msg.windowMs, msg.minHz, msg.maxHz);
        try {
            await renderer.init(msg.canvas);
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
