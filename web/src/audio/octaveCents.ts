// Compute octave-reduced cents between voice and root. Result is in
// [0, 1200) per the chord-aware-display algorithm sketch's step 2
// formula: ((1200 * log2(voice/root)) mod 1200 + 1200) mod 1200.
//
// Voices an octave apart collapse to the same value (root → 0). Voices
// below root produce the correct positive cents value for that pitch
// class.
export function octaveReducedCents(voiceHz: number, rootHz: number): number {
    const raw = 1200 * Math.log2(voiceHz / rootHz);
    const reduced = ((raw % 1200) + 1200) % 1200;

    return reduced;
}
