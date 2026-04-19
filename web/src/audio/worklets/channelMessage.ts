// Wire contract between pitchWorklet.ts (AudioWorkletGlobalScope) and
// voiceChannel.ts (main thread). Both sides import this file so the shape
// and the processor name cannot drift silently.

export const PITCH_PROCESSOR_NAME = 'pitch-processor';

export type ChannelMessageType = 'pitch';

export interface ChannelMessage {
    type: ChannelMessageType;
    fundamentalHz: number;
    confidence: number;
    rmsDb: number;
}
