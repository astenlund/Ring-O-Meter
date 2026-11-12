// Cross-origin isolation (COOP/COEP) is required for SharedArrayBuffer
// + Atomics, which frameRing.ts uses for the lock-free frame transport.
// Every surface that serves the app or its tests must send these headers,
// or browsers silently refuse to enable SharedArrayBuffer.
//
// Lockstep set: the two web configs share this module; the deployed
// server carries its own copy of the same values.
//   web/crossOriginHeaders.ts         (this file)
//     imported by web/vite.config.ts            (server + preview blocks)
//     imported by web/vitest.browser.config.ts  (Vitest browser-mode test host)
//   src/RingOMeter.Server/Program.cs  (deployed server, own copy)
// Diagnostic: if `self.crossOriginIsolated` is false in any environment,
// one of those locations is out of sync.
export const crossOriginHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
};
