import type {AnalysisFrame} from '../wire/frames';

// Wire contract between main thread (plotController.ts) and worker
// (plotWorker.ts). VoiceStyle + VoiceEntry live here because they are
// serialized across the postMessage boundary; paint.ts re-exports the
// type aliases so module-local callers import from the closer location.

export interface VoiceStyle {
    label: string;
    color: string;
}

export type VoiceEntry = VoiceStyle & {channelId: string};

export interface InitMessage {
    type: 'init';
    canvas: OffscreenCanvas;
    voices: ReadonlyArray<VoiceEntry>;
    backing: {cssWidth: number; cssHeight: number; dpr: number};
    windowMs: number;
    minHz: number;
    maxHz: number;
    traceCapacity: number;
    // Main thread's performance.now() captured at init-post time. The
    // worker subtracts its own performance.now() at init-receive time to
    // derive a one-shot main-vs-worker epoch offset. Paint uses the
    // offset so nowMs matches the clientNowMs timestamps in the trace
    // buffer, which are stamped with main-thread time at publishFrame.
    // Worker's timeOrigin is the worker's creation time, not the
    // document's navigation start, so without this reconciliation every
    // sample's tsMs > nowMs and traces draw off the right edge of the
    // canvas.
    mainNowAtInitMs: number;
}

export interface SetRosterMessage {
    type: 'setRoster';
    voices: ReadonlyArray<VoiceEntry>;
}

export interface SetBackingMessage {
    type: 'setBacking';
    cssWidth: number;
    cssHeight: number;
    dpr: number;
}

export interface FrameMessage {
    type: 'frame';
    frame: AnalysisFrame;
    // Audio-thread-stamped capture instant converted to main's
    // performance.now() basis (see VoiceChannelOptions.onFrame in
    // voiceChannel.ts for the calibration). Stays aligned with the
    // worker's paint nowMs epoch via the InitMessage.mainNowAtInitMs
    // reconciliation, so trace positions reflect when audio was
    // captured, not when main got around to posting.
    clientNowMs: number;
}

export type PlotMessage = InitMessage | SetRosterMessage | SetBackingMessage | FrameMessage;
