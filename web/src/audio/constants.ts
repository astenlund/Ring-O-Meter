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
