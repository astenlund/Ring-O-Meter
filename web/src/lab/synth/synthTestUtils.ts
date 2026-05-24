// Shared analysis helpers for the lab/synth browser tests (voiceGraph,
// chordSynth, and future render tests). Not a test file itself; imported by
// the *.browser.ts suites. Mirrors the shared-test-harness pattern used by
// web/src/__tests__/allocHarness.ts.

// Goertzel single-bin magnitude at targetHz over the given samples. Used to
// probe spectral energy at a specific frequency in a rendered buffer.
export function goertzelMagnitude(samples: Float32Array, targetHz: number, sampleRate: number): number {
    const k = Math.round((samples.length * targetHz) / sampleRate);
    const w = (2 * Math.PI * k) / samples.length;
    const cosW = Math.cos(w);
    const coeff = 2 * cosW;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < samples.length; i++) {
        const s0 = samples[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const real = s1 - s2 * cosW;
    const imag = s2 * Math.sin(w);

    return Math.sqrt(real * real + imag * imag) / samples.length;
}

export function rms(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
    }

    return Math.sqrt(sum / samples.length);
}
