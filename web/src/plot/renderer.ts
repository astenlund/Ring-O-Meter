// Renderer choice surfaced as a discriminated union so the WebGPU
// worker URL and the underlay-canvas requirement stay statically
// linked. The previous two-boolean shape (rendererWorkerUrl + useUnderlay)
// admitted invalid combinations like "useUnderlay=true,
// rendererWorkerUrl=undefined": no compile-time error, no runtime
// guard, just a silent visual regression where the underlay canvas
// was mounted on the 2D arm. The discriminated union eliminates
// that failure mode at the type level: every consumer pattern-matches
// `kind` and the WebGPU-only fields appear only in the WebGPU
// branch.
//
// `kind: '2d'` carries no fields today; it stays an object (rather
// than a literal string) so future 2D-only fields (e.g., a software-
// renderer fallback hint or a color-space override) can be added
// without rewriting every consumer's type guard.
export type Renderer =
    | {readonly kind: 'webgpu'; readonly workerUrl: string}
    | {readonly kind: '2d'}
    | {readonly kind: 'trace'; readonly workerUrl: string};
