// Audio-pipeline constants that are shared across the main thread and the
// AudioWorklet. The worklet itself reads the authoritative `sampleRate`
// global at runtime (which reflects whatever the browser actually
// negotiated), so this constant only governs the CONTEXT creation hint
// and the test-fixture rate — if the two drift, the tests stop being a
// valid proxy for in-browser behaviour.

export const TARGET_SAMPLE_RATE_HZ = 48000;
