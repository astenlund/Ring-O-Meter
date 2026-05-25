// Equal-power (constant-power) crossfade gain pair, shared by the A/B toggle's gain
// ramp (labAudioPlayer) and the loop-seam overlap-add (seamlessLoop). Returns
// [fromGain, toGain] for fraction t in [0,1]: fromGain falls 1->0 (cos), toGain
// rises 0->1 (sin); fromGain^2 + toGain^2 = 1 holds throughout.
const FADE_PI_OVER_2 = Math.PI / 2;

export function equalPowerGains(t: number): [number, number] {
    const clamped = Math.min(1, Math.max(0, t));

    return [Math.cos(clamped * FADE_PI_OVER_2), Math.sin(clamped * FADE_PI_OVER_2)];
}
