// Visual-axis half-range for the chord-bars renderers. Shared by the 2D
// (chordBarsModule.ts) and WebGPU (chordBarsModuleWebgpu.ts) paths so
// both renderers draw bars on the same ±N¢ axis. Tuning this rescales
// both arms in lockstep; consumers must move together.

// heuristic: chord-bars-scale-half-cents - full half-range of the ±N¢
// per-voice cents-from-JI axis.
export const SCALE_HALF_CENTS = 50;
