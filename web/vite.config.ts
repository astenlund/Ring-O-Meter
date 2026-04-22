import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation (COOP/COEP) is required for SharedArrayBuffer
// + Atomics, which frameRing.ts uses for the lock-free frame transport.
// Both dev (pnpm dev) and preview (Playwright webServer uses pnpm
// preview) need the headers. Bundle is fully self-contained (no CDN
// scripts, no cross-origin embeds), so COEP require-corp does not fight
// any subresource.
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
