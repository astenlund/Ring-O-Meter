// Test-only: URL query-string flag selecting an experimental rendering
// path. ?renderer=webgpu opts a session into the prototype WebGPU plot
// worker (web/src/plot/plotWorkerWebgpu.ts); absent or unrecognised
// values keep the production 2D canvas worker
// (web/src/plot/plotWorker.ts).
//
// Parsed once at App mount; returns null in production. Mirrors the
// shape of fanoutFlag.ts so App.tsx's call site reads consistently.
//
// Cleanup: when the prototype graduates to a production decision (per
// the .claude/specs/2026-04-30-webgpu-plot-prototype.md decision tree),
// either promote this to a non-test renderer-selection module (if the
// flag stays as a user-facing toggle) or rm the file alongside the
// WebGPU worker (if Option D wins and the prototype is retired).

export type RendererSelection = 'webgpu';

export function parseRendererFlag(search: string): RendererSelection | null {
    const params = new URLSearchParams(search);
    const value = params.get('renderer');
    if (value === null) {
        return null;
    }
    if (value === 'webgpu') {
        return 'webgpu';
    }
    console.warn(`[renderer] unrecognised value ${value}; using production path`);

    return null;
}
