// Wire contract between main (plotController.ts) and worker
// (plotWorker.ts). Per-frame data flows via SAB now;
// AttachChannelMessage carries the SAB reference (shared, not
// transferred - SAB is not Transferable). Remaining message variants
// handle lifecycle events and the one-time canvas transfer at init.

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
    // Main thread's performance.now() captured at init-post time. The
    // worker subtracts its own performance.now() at init-receive time to
    // derive a one-shot main-vs-worker epoch offset. Paint uses the
    // offset so nowMs matches the reader's paint-epoch tsMs (derived
    // via each ring's perfNowAtContextTimeZero). Worker's timeOrigin is
    // the worker's creation time, not the document's navigation start,
    // so without this reconciliation every sample's tsMs > nowMs and
    // traces draw off the right edge of the canvas.
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

export interface AttachChannelMessage {
    type: 'attachChannel';
    channelId: string;
    // SAB is shared, not transferred. Do NOT include in the
    // postMessage transfer list - SharedArrayBuffer is not
    // Transferable and including it throws DataCloneError.
    sab: SharedArrayBuffer;
    perfNowAtContextTimeZero: number;
}

export interface DetachChannelMessage {
    type: 'detachChannel';
    channelId: string;
}

export interface RebaseChannelMessage {
    type: 'rebaseChannel';
    channelId: string;
    perfNowAtContextTimeZero: number;
}

export type PlotMessage =
    | InitMessage
    | SetRosterMessage
    | SetBackingMessage
    | AttachChannelMessage
    | DetachChannelMessage
    | RebaseChannelMessage;
