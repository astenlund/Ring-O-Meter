// Renderer-agnostic color parsing. Both the trace's WebGPU pipeline
// and the vowel module's per-voice color uniforms consume this; lives
// outside paint.ts (which is 2D-canvas-shaped) and outside both
// renderer modules so neither has to import the other for a primitive.
//
// Supports 3-digit (#5cf) and 6-digit (#55ccff) hex; does NOT handle
// named colors or rgb()/rgba() syntax. The codebase exclusively uses
// hex triples in SLOT_COLORS today; throws on unsupported input rather
// than silently rendering black.

export function hexToRgba(hex: string, out: Float32Array): void {
    if (hex.length === 4 && hex[0] === '#') {
        const r = parseInt(hex[1] + hex[1], 16);
        const g = parseInt(hex[2] + hex[2], 16);
        const b = parseInt(hex[3] + hex[3], 16);
        out[0] = r / 255;
        out[1] = g / 255;
        out[2] = b / 255;
        out[3] = 1;

        return;
    }
    if (hex.length === 7 && hex[0] === '#') {
        out[0] = parseInt(hex.slice(1, 3), 16) / 255;
        out[1] = parseInt(hex.slice(3, 5), 16) / 255;
        out[2] = parseInt(hex.slice(5, 7), 16) / 255;
        out[3] = 1;

        return;
    }
    throw new Error(`hexToRgba: unsupported color ${hex}`);
}
