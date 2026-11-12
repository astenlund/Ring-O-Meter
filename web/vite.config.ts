import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {crossOriginHeaders} from './crossOriginHeaders';

// Both dev (pnpm dev) and preview (Playwright webServer uses pnpm
// preview) need the COOP/COEP headers; crossOriginHeaders.ts holds the
// values and the lockstep set. Bundle is fully self-contained (no CDN
// scripts, no cross-origin embeds), so COEP require-corp does not fight
// any subresource.

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
            // Print extra dev-only route URLs alongside Vite's normal
            // startup banner, wrapping `server.printUrls` so the lines
            // appear after Vite's Local / Network lines instead of racing
            // them. `?fanout` is what a dev iterating on the chord-aware
            // feature clicks (the bare URL shows no visualization until a
            // real quartet sings); `/lab` is the dev-only synthesis-
            // calibration UI (gated `import.meta.env.DEV`, tree-shaken from
            // production builds).
            name: 'dev-print-route-urls',
            configureServer(server) {
                const original = server.printUrls.bind(server);
                server.printUrls = () => {
                    original();
                    const localUrls = server.resolvedUrls?.local ?? [];
                    for (const url of localUrls) {
                        const base = url.endsWith('/') ? url : `${url}/`;
                        console.log(`  ${GREEN}➜${RESET_FG}  ${BOLD}Fanout:${RESET_DIM}  ${CYAN}${base}?fanout${RESET_FG}`);
                        console.log(`  ${GREEN}➜${RESET_FG}  ${BOLD}Lab:${RESET_DIM}     ${CYAN}${base}lab${RESET_FG}`);
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
