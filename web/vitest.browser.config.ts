import {defineConfig} from 'vitest/config';
import {playwright} from '@vitest/browser-playwright';
import react from '@vitejs/plugin-react';

// Browser-hosted tests: real canvas, real rAF, performance.memory.
// Chromium launched with --expose-gc so alloc tests can force
// deterministic GC between measurement windows. In Vitest 4 the
// provider is a factory (not a string name); launchOptions are
// passed through the factory and flow to Playwright's
// BrowserType.launch().
export default defineConfig({
    plugins: [react()],
    test: {
        include: ['src/**/*.browser.ts', 'src/**/*.browser.tsx'],
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
