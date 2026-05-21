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

// ANSI escape sequences for the dev-print-fanout-url banner. Raw
// escapes avoid a picocolors import that would couple this plugin
// to Vite's internal deps. Codes match Vite's own banner styling.
const ESC = '';
const GREEN = `${ESC}[32m`;
const BOLD = `${ESC}[1m`;
const CYAN = `${ESC}[36m`;
const RESET_FG = `${ESC}[39m`;
const RESET_DIM = `${ESC}[22m`;

export default defineConfig({
    plugins: [
        react(),
        {
            name: 'dev-config-json',
            configureServer(server) {
                server.middlewares.use('/config.json', (_req, res) => {
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({hubUrl: '', devModesEnabled: true}));
                });
            },
        },
        {
            // Print a `?fanout` URL alongside Vite's normal startup
            // banner. The bare URL exercises the production path (no
            // chord-aware visualization until a real quartet sings); the
            // `?fanout` URL is what a dev solo-iterating on the
            // chord-aware feature actually wants to click. Wraps
            // `server.printUrls` so the extra line appears after Vite's
            // Local / Network lines instead of racing them.
            name: 'dev-print-fanout-url',
            configureServer(server) {
                const original = server.printUrls.bind(server);
                server.printUrls = () => {
                    original();
                    const localUrls = server.resolvedUrls?.local ?? [];
                    for (const url of localUrls) {
                        const fanoutUrl = url.endsWith('/') ? `${url}?fanout` : `${url}/?fanout`;
                        // eslint-disable-next-line no-console
                        console.log(`  ${GREEN}➜${RESET_FG}  ${BOLD}Fanout:${RESET_DIM}  ${CYAN}${fanoutUrl}${RESET_FG}`);
                    }
                };
            },
        },
    ],
    server: {
        port: 5173,
        headers: crossOriginHeaders,
    },
    preview: {
        port: 4173,
        headers: crossOriginHeaders,
    },
});
