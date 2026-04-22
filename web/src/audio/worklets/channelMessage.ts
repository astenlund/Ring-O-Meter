// Wire contract between pitchWorklet.ts (AudioWorkletGlobalScope) and
// voiceChannel.ts (main thread). Per-frame data flows via the SAB
// now; this channel is reserved for future non-frame events (errors,
// diagnostics, parameter updates).
//
// ChannelMessage retained as a seam: the discriminator keeps a shape
// to extend when the first non-frame variant appears. Today there
// are no variants in active use - the worklet does not post on the
// port during steady-state operation.

export const PITCH_PROCESSOR_NAME = 'pitch-processor';

export type ChannelMessageType = 'pitch';

export interface ChannelMessage {
    type: ChannelMessageType;
}
