// Test-only leaf module declaring the AudioWorkletProcessor name for the
// fanout worklet. Mirrors web/src/audio/constants.ts's
// PITCH_PROCESSOR_NAME pattern: must be import-safe in BOTH
// AudioWorkletGlobalScope (where fanoutWorklet.ts calls
// registerProcessor with this literal at top level) and the main thread
// (where fanoutVoiceChannel.ts passes it to new AudioWorkletNode). No
// transitive imports, no top-level side effects.
//
// Cleanup: rm this file along with fanoutWorklet.ts and
// fanoutVoiceChannel.ts when the fanout test mode is retired.
export const PITCH_FANOUT_PROCESSOR_NAME = 'pitch-fanout-processor';
