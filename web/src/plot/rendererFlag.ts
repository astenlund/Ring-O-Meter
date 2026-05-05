// URL query-string flag selecting the rendering path. As of 2026-04-30
// the production default is WebGPU
// (web/src/plot/plotWorkerWebgpu.ts); ?renderer=2d opts back into the
// 2D canvas worker (web/src/plot/plotWorker2dCanvas.ts). ?renderer=webgpu
// stays accepted as an explicit no-op selector for symmetry. Returns
// null when the flag is absent (caller picks the default).
//
// Parsed once at App.tsx mount; mid-session toggling is not
// supported. Mirror of fanoutFlag.ts shape so App.tsx's call site
// reads consistently across both flags.

export type RendererSelection = '2d' | 'webgpu';

export function parseRendererFlag(search: string): RendererSelection | null {
    const params = new URLSearchParams(search);
    const value = params.get('renderer');
    if (value === null) {
        return null;
    }
    if (value === '2d' || value === 'webgpu') {
        return value;
    }
    console.warn(`[renderer] unrecognised value ${value}; using production default`);

    return null;
}
