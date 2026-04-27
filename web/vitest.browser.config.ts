import {defineConfig} from 'vitest/config';
import {playwright} from '@vitest/browser-playwright';
import react from '@vitejs/plugin-react';

// Browser-hosted tests: real canvas, real rAF, performance.memory.
// Chromium launched with --expose-gc so alloc tests can force
// deterministic GC between measurement windows. In Vitest 4 the
// provider is a factory (not a string name); launchOptions are
// passed through the factory and flow to Playwright's
// BrowserType.launch().
//
// The Vitest browser runner hosts the tests on its own Vite server;
// SharedArrayBuffer requires cross-origin isolation there too, so
// we mirror vite.config.ts's COOP/COEP headers onto this server
// block. Without them, any alloc test that touches frameRing.ts
// (which needs SAB) fails with ReferenceError: SharedArrayBuffer
// is not defined.
export default defineConfig({
    plugins: [react()],
    server: {
        headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
        },
    },
    test: {
        include: ['src/**/*.browser.ts', 'src/**/*.browser.tsx'],
        setupFiles: ['./vitest.browser.setup.ts'],
        browser: {
            enabled: true,
            provider: playwright({
                launchOptions: {
                    // --expose-gc: enables globalThis.gc() for deterministic
                    //   collection between measurement windows.
                    // --enable-precise-memory-info: disables Chromium's
                    //   default bucketing of performance.memory (coarse
                    //   ~100 KB resolution as an anti-fingerprinting
                    //   mitigation). Without this flag, budgets below
                    //   the bucket size read as 0 or 100 KB at random.
                    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
                },
            }),
            headless: true,
            instances: [{browser: 'chromium'}],
        },
    },
});
