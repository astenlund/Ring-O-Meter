/// <reference lib="webworker" />

import {PlotMessageType, type PlotMessage} from './plotMessages';
import {WebgpuPlotRenderer} from './webgpuPlotRenderer';

const renderer = new WebgpuPlotRenderer();
let initialised = false;
let initFailed = false;
const pendingMessages: PlotMessage[] = [];
let rafId = 0;

function paintLoop(): void {
    renderer.paint();
    rafId = requestAnimationFrame(paintLoop);
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
                rafId = requestAnimationFrame(paintLoop);
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
            rafId = requestAnimationFrame(paintLoop);
        }

        return;
    }
    if (!initialised) {
        pendingMessages.push(msg);

        return;
    }
    applyMessage(msg);
};
