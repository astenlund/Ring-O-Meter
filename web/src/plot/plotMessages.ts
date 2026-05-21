// Wire contract between main (plotController.ts) and the plot worker
// (plotWorker2dCanvas.ts on the 2D fallback arm; plotWorkerWebgpu.ts
// on the WebGPU production arm). Per-frame data flows via SAB now;
// AttachChannelMessage carries a FrameSource descriptor (SAB is
// shared, not transferred - SAB is not Transferable). Remaining
// message variants handle lifecycle events and the one-time canvas
// transfer at init. Both workers consume the same PlotMessage union;
// asymmetries (e.g., webgpuInitError + vowelInitError surface only
// from the WebGPU worker) flow as out-of-band postMessage events
// rather than typed PlotMessage variants.

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
    InitVowelCanvas: 'initVowelCanvas',
    AttachVowelChannel: 'attachVowelChannel',
    DetachVowelChannel: 'detachVowelChannel',
    RebaseVowelChannel: 'rebaseVowelChannel',
    SetVowelBacking: 'setVowelBacking',
    InitChordBarsCanvas: 'initChordBarsCanvas',
    SetChordBarsBacking: 'setChordBarsBacking',
    SetChordClassification: 'setChordClassification',
} as const;

export interface InitMessage {
    type: typeof PlotMessageType.Init;
    canvas: OffscreenCanvas;
    voices: ReadonlyArray<VoiceEntry>;
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
    // When true, the worker renders only the pitch trace and ignores any
    // InitVowelCanvas / InitChordBarsCanvas messages. Used by the
    // ?renderer=trace dev-opt-in arm to reuse plotWorkerWebgpu.ts without
    // allocating the vowel or chord-bars canvases. Absent or false leaves
    // behavior unchanged (all modules active).
    traceOnly?: boolean;
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

export interface InitVowelCanvasMessage {
    type: typeof PlotMessageType.InitVowelCanvas;
    canvas: OffscreenCanvas;
}

export interface AttachVowelChannelMessage {
    type: typeof PlotMessageType.AttachVowelChannel;
    channelId: string;
    color: string;
    source: FrameSource;
}

export interface DetachVowelChannelMessage {
    type: typeof PlotMessageType.DetachVowelChannel;
    channelId: string;
}

export interface RebaseVowelChannelMessage {
    type: typeof PlotMessageType.RebaseVowelChannel;
    channelId: string;
    epochOffsetMs: number;
}

export interface SetVowelBackingMessage {
    type: typeof PlotMessageType.SetVowelBacking;
    cssWidth: number;
    cssHeight: number;
    dpr: number;
}

export interface InitChordBarsCanvasMessage {
    type: typeof PlotMessageType.InitChordBarsCanvas;
    canvas: OffscreenCanvas;
}

export interface SetChordBarsBackingMessage {
    type: typeof PlotMessageType.SetChordBarsBacking;
    cssWidth: number;
    cssHeight: number;
    dpr: number;
}

export interface SetChordClassificationMessage {
    type: typeof PlotMessageType.SetChordClassification;
    lockedChordType: number | null;     // ChordType enum int or null
    rootChannelId: string | null;
    rootHz: number;                     // 0 when no chord locked
    residualsBySlot: Float32Array;      // NaN sentinel for absent voices
}

export type PlotMessage =
    | InitMessage
    | SetRosterMessage
    | SetBackingMessage
    | AttachChannelMessage
    | DetachChannelMessage
    | RebaseChannelMessage
    | InitVowelCanvasMessage
    | AttachVowelChannelMessage
    | DetachVowelChannelMessage
    | RebaseVowelChannelMessage
    | SetVowelBackingMessage
    | InitChordBarsCanvasMessage
    | SetChordBarsBackingMessage
    | SetChordClassificationMessage;
