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
// channel: 'chrome' uses the system-installed Chrome rather than
// Playwright's bundled Chromium. Same reason as playwright.config.ts
// for the e2e suite: bundled Chromium 1217 does not supply a WebGPU
// adapter on Windows even with --enable-unsafe-webgpu (verified
// 2026-04-30); the WebGPU plot paint alloc test
// (plotWorkerWebgpu.alloc.browser.ts) needs a real GPUDevice. System
// Chrome has WebGPU enabled by default. Trade-offs match the e2e
// case: Chrome must be installed locally and on any CI runner that
// runs the alloc suite.
//
// The Vitest browser runner hosts the tests on its own Vite server;
// SharedArrayBuffer requires cross-origin isolation there too, so we
// mirror the COOP/COEP headers onto this server block. Without them,
// any alloc test that touches frameRing.ts (which needs SAB) fails
// with ReferenceError: SharedArrayBuffer is not defined.
//
// Lockstep set (change all together):
//   web/vite.config.ts                (server + preview blocks)
//   web/vitest.browser.config.ts      (this file)
//   src/RingOMeter.Server/Program.cs  (slice 1a deployed server)
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
                    channel: 'chrome',
                    // --expose-gc: enables globalThis.gc() for deterministic
                    //   collection between measurement windows.
                    // --enable-precise-memory-info: disables Chromium's
                    //   default bucketing of performance.memory (coarse
                    //   ~100 KB resolution as an anti-fingerprinting
                    //   mitigation). Without this flag, budgets below
                    //   the bucket size read as 0 or 100 KB at random.
                    // --enable-unsafe-webgpu: belt-and-braces. System
                    //   Chrome ships WebGPU enabled by default, so the
                    //   plotWorkerWebgpu.alloc.browser.ts test can
                    //   construct a real GPUDevice without this flag.
                    //   Kept against a hypothetical regression where
                    //   Chrome demotes WebGPU to opt-in. Do NOT pair
                    //   with --enable-features=Vulkan; it would shift
                    //   the prototype off the Dawn -> D3D12 backend
                    //   that matches the #skia-graphite reference
                    //   architecture
                    //   (.claude/specs/2026-04-30-webgpu-plot-prototype.md).
                    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info', '--enable-unsafe-webgpu'],
                },
            }),
            headless: true,
            instances: [{browser: 'chromium'}],
        },
    },
});
