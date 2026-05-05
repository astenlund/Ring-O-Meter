// Audio-pipeline constants that are shared across the main thread and the
// AudioWorklet. The worklet itself reads the authoritative `sampleRate`
// global at runtime (which reflects whatever the browser actually
// negotiated), so this constant only governs the CONTEXT creation hint
// and the test-fixture rate — if the two drift, the tests stop being a
// valid proxy for in-browser behaviour.

export const TARGET_SAMPLE_RATE_HZ = 48000;

// Ceiling on how fast the worklet is allowed to publish analysis frames.
// The worklet currently runs at ~47 Hz; 60 Hz leaves headroom for tuning
// without forcing consumers (plot ring buffer sizing, throttles) to grow
// their bounds. Owned here because it's a property of the worklet's
// publish cadence, not of any particular consumer.
export const MAX_PUBLISH_HZ = 60;

// Name registered by the AudioWorklet (registerProcessor side) and
// consumed by the main thread (new AudioWorkletNode side). Owned here
// because both sides need to agree on the literal and the constant must
// import-cleanly from both realms — pitchWorklet.ts itself runs
// registerProcessor at top level and is not main-thread-import-safe.
export const PITCH_PROCESSOR_NAME = 'pitch-processor';

// FRAME_SIZE is the publish-frame unit (~21 ms at 48 kHz): how often the
// worklet's publish() runs, and the window size that RMS + formants
// analyse. ANALYSIS_WINDOW_SIZE is the YIN-only window (2 * FRAME_SIZE):
// YIN needs at least 2 cycles of the lowest detectable frequency to
// find a clean autocorrelation lag, and 1024 samples bottoms out at
// ~94 Hz - just above F#2, leaving E2/F2 (real bass-singer notes,
// 82-87 Hz) in a detection-blind zone. Doubling the YIN window pushes
// the floor below C2 (~47 Hz) without changing the publish rate, at
// the cost of ~4x YIN compute per publish (still well within the
// 21 ms worklet budget). RMS and formants stay on the 1024-sample
// latest-frame view because more history doesn't help those analyses.
//
// Owned here so a future input-window retune is one constant edit with
// type-checked propagation; formantDetector's scratch buffers and both
// worklets' rolling windows derive their sizes from these constants.
export const FRAME_SIZE = 1024;
export const ANALYSIS_WINDOW_SIZE = FRAME_SIZE * 2;
