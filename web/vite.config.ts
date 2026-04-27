import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation (COOP/COEP) is required for SharedArrayBuffer
// + Atomics, which frameRing.ts uses for the lock-free frame transport.
// Both dev (pnpm dev) and preview (Playwright webServer uses pnpm
// preview) need the headers. Bundle is fully self-contained (no CDN
// scripts, no cross-origin embeds), so COEP require-corp does not fight
// any subresource.
//
// Lockstep set: change these values here and in every other location
// that ships them, or browsers will silently fail to enable
// SharedArrayBuffer. The full set:
//   web/vite.config.ts                (this file, server + preview)
//   web/vitest.browser.config.ts      (Vitest browser-mode test host)
//   src/RingOMeter.Server/Program.cs  (slice 1a deployed server)
// Diagnostic: if `self.crossOriginIsolated` is false in any
// environment, one of those locations is out of sync.
const crossOriginHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        headers: crossOriginHeaders,
    },
    preview: {
        port: 4173,
        headers: crossOriginHeaders,
    },
});
