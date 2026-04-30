// WGSL shader sources for the WebGPU prototype plot worker. Vertex
// layout: (offsetMs: f32, hz: f32), 8 bytes per vertex. Topology is
// line-strip at 1 device pixel; thick-line tessellation is a deferred
// follow-up if Option C ships (see
// .claude/specs/2026-04-30-webgpu-plot-prototype.md "Out of scope").
//
// IMPORTANT: vertices store `tsMs - startMs` (the per-paint window
// offset), NOT absolute `tsMs`. f32 has ~7 decimal digits of mantissa
// precision; absolute paint-epoch milliseconds reach 10^6-10^8 over a
// long session (Task 13's 30-min arm crosses 1.8M ms), where f32
// spacing is 0.125-8 ms. Subtracting startMs in the shader against
// near-equal large f32 operands produces catastrophic cancellation
// and visible vertex jitter. By subtracting on the CPU before the
// f32 narrowing (per-paint, in webgpuPlotRenderer.paint()), every
// vertex value lands in [0, windowMs] = [0, 10000] where f32 spacing
// is < 0.001 ms - well below any visible threshold. The shader then
// just normalises by windowMs.
//
// The vertex shader maps:
//   x_ndc = -1 + 2 * offsetMs / windowMs
//   y_ndc =  1 - 2 * (log(hz) - logMin) / logSpan
// matching the 2D canvas's drawTraces math (paint.ts: makeHzToY +
// startMs window math). The fragment shader emits a constant color
// supplied via a per-draw push uniform group.

export const VERTEX_WGSL = /* wgsl */ `
struct Viewport {
    windowMs: f32,
    logMinHz: f32,
    logSpanHz: f32,
    _pad: f32,
};

struct VoiceUniform {
    color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> viewport: Viewport;
@group(0) @binding(1) var<uniform> voice: VoiceUniform;

struct VsIn {
    @location(0) offsetMs: f32,
    @location(1) hz: f32,
};

struct VsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VsIn) -> VsOut {
    let xNorm = input.offsetMs / viewport.windowMs;
    let xNdc = -1.0 + 2.0 * xNorm;
    let yNorm = (log(input.hz) - viewport.logMinHz) / viewport.logSpanHz;
    let yNdc = 1.0 - 2.0 * yNorm;
    var out: VsOut;
    out.position = vec4<f32>(xNdc, yNdc, 0.0, 1.0);
    out.color = voice.color;
    return out;
}
`;

export const FRAGMENT_WGSL = /* wgsl */ `
struct FsIn {
    @location(0) color: vec4<f32>,
};

@fragment
fn fs_main(input: FsIn) -> @location(0) vec4<f32> {
    return input.color;
}
`;
