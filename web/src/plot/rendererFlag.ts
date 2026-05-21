// URL query-string flag selecting the rendering path. As of 2026-05-21
// the production default is the 2D canvas worker
// (web/src/plot/plotWorker2dCanvas.ts) while WebGPU completes
// optimization work; ?renderer=webgpu opts into the WebGPU worker
// (web/src/plot/plotWorkerWebgpu.ts). ?renderer=2d stays accepted as
// an explicit no-op selector for symmetry. ?renderer=trace is a dev-only
// arm gated by devModesEnabled from /config.json. Returns null when the
// flag is absent (caller picks the default).
//
// Parsed once at App.tsx mount; mid-session toggling is not
// supported. Mirror of fanoutFlag.ts shape so App.tsx's call site
// reads consistently across both flags.

export type RendererSelection = '2d' | 'webgpu' | 'trace';

let _warnedAboutIgnoredRenderer = false;

// devModesEnabled has a default value so existing call sites (App.tsx,
// the existing test file) compile until Task 21 wires the real value
// through. The default is `false` to match the production fail-closed
// contract.
export function parseRendererFlag(
    search: string,
    devModesEnabled = false,
): RendererSelection | null {
    const params = new URLSearchParams(search);
    const value = params.get('renderer');
    if (value === null) {
        return null;
    }
    if (value === '2d' || value === 'webgpu') {
        return value;
    }
    if (value === 'trace') {
        if (devModesEnabled) {
            return 'trace';
        }
        if (!_warnedAboutIgnoredRenderer) {
            console.warn('[ring-o-meter] ?renderer=trace ignored in this environment (devModesEnabled: false)');
            _warnedAboutIgnoredRenderer = true;
        }

        return null;
    }
    console.warn(`[renderer] unrecognised value ${value}; using production default`);

    return null;
}
