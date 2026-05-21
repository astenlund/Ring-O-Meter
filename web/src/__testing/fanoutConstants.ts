// Test-only leaf module declaring the AudioWorkletProcessor name for the
// fanout worklet. Mirrors web/src/audio/constants.ts's
// PITCH_PROCESSOR_NAME pattern: must be import-safe in BOTH
// AudioWorkletGlobalScope (where fanoutWorklet.ts calls
// registerProcessor with this literal at top level) and the main thread
// (where fanoutVoiceChannel.ts passes it to new AudioWorkletNode). No
// transitive imports, no top-level side effects.
//
// Permanent dev-mode infrastructure; gated by devModesEnabled in /config.json.
export const PITCH_FANOUT_PROCESSOR_NAME = 'pitch-fanout-processor';
