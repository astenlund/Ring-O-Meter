// Wire contract between main (plotController.ts) and worker
// (plotWorker.ts). Per-frame data flows via SAB now;
// AttachChannelMessage carries a FrameSource descriptor (SAB is
// shared, not transferred - SAB is not Transferable). Remaining
// message variants handle lifecycle events and the one-time canvas
// transfer at init.

import type {FrameSource} from '../audio/frameRing';

export interface VoiceStyle {
    label: string;
    color: string;
}

export type VoiceEntry = VoiceStyle & {channelId: string};

export const PlotMessageType = {
    Init: 'init',
    SetRoster: 'setRoster',
    SetBacking: 'setBacking',
    AttachChannel: 'attachChannel',
    DetachChannel: 'detachChannel',
    RebaseChannel: 'rebaseChannel',
} as const;

export interface InitMessage {
    type: typeof PlotMessageType.Init;
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
    // via each ring's epochOffsetMs). Worker's timeOrigin is the
    // worker's creation time, not the document's navigation start, so
    // without this reconciliation every sample's tsMs > nowMs and
    // traces draw off the right edge of the canvas.
    mainNowAtInitMs: number;
}

export interface SetRosterMessage {
    type: typeof PlotMessageType.SetRoster;
    voices: ReadonlyArray<VoiceEntry>;
}

export interface SetBackingMessage {
    type: typeof PlotMessageType.SetBacking;
    cssWidth: number;
    cssHeight: number;
    dpr: number;
}

export interface AttachChannelMessage {
    type: typeof PlotMessageType.AttachChannel;
    channelId: string;
    // SAB inside source is shared, not transferred. Do NOT include it
    // in the postMessage transfer list - SharedArrayBuffer is not
    // Transferable and including it throws DataCloneError.
    source: FrameSource;
}

export interface DetachChannelMessage {
    type: typeof PlotMessageType.DetachChannel;
    channelId: string;
}

export interface RebaseChannelMessage {
    type: typeof PlotMessageType.RebaseChannel;
    channelId: string;
    epochOffsetMs: number;
}

export type PlotMessage =
    | InitMessage
    | SetRosterMessage
    | SetBackingMessage
    | AttachChannelMessage
    | DetachChannelMessage
    | RebaseChannelMessage;
