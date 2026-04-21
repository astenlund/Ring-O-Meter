// Wire contract between pitchWorklet.ts (AudioWorkletGlobalScope) and
// voiceChannel.ts (main thread). Both sides import this file so the shape
// and the processor name cannot drift silently.

export const PITCH_PROCESSOR_NAME = 'pitch-processor';

// The type discriminator has only one variant today but is kept as a seam
// for future worklet→main messages (e.g. an error payload, or a formant
// frame in slice 5). Drop it only if we decide the worklet will never
// emit anything but pitch frames.
export type ChannelMessageType = 'pitch';

export interface ChannelMessage {
    type: ChannelMessageType;
    fundamentalHz: number;
    confidence: number;
    rmsDb: number;
    // AudioContext-time seconds at the end of the analysis window that
    // produced this message. Stamped in the worklet (audio thread) so
    // it is immune to main-thread GC pauses. voiceChannel converts it
    // to a main-thread performance.now() basis for paint positioning
    // via a one-shot offset calibration on the first frame.
    captureContextTime: number;
}
