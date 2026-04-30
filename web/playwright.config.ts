import {defineConfig} from '@playwright/test';
import {join} from 'node:path';

// web/package.json is "type": "module", so __dirname is not defined.
// import.meta.dirname (Node 20.11+) resolves cleanly; the repo requires
// Node 22+ per CLAUDE.md.
const audioFile = join(import.meta.dirname, 'test-fixtures', 'sustained-vowel.wav');

export default defineConfig({
    testDir: './e2e',
    timeout: 180_000,
    fullyParallel: false,
    workers: 1,
    reporter: 'list',
    use: {
        baseURL: 'http://localhost:4173',
        launchOptions: {
            args: [
                '--js-flags=--expose-gc',
                // Disable Chromium's default bucketing of
                // performance.memory (~100 KB resolution as an
                // anti-fingerprinting mitigation). Without this the
                // heap-delta assertion below rounds to bucket ticks
                // and tolerates ~10x more growth than stated.
                '--enable-precise-memory-info',
                '--autoplay-policy=no-user-gesture-required',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                `--use-file-for-fake-audio-capture=${audioFile}`,
                // WebGPU is the production default renderer
                // (web/src/plot/plotWorkerWebgpu.ts). System Chrome
                // ships WebGPU enabled by default; this flag is kept
                // as belt-and-braces against a hypothetical regression
                // where Chrome demotes WebGPU to opt-in. Do NOT add
                // --enable-features=Vulkan, which would shift the
                // backend off Dawn -> D3D12 (the architecture the
                // spec measured against #skia-graphite's
                // GraphiteDawnD3D11). The smoothness e2e's WebGPU
                // arm hard-asserts a usable adapter and fails fast
                // if WebGPU isn't actually enabled at the host.
                '--enable-unsafe-webgpu',
            ],
        },
    },
    webServer: {
        command: 'pnpm build && pnpm preview --port 4173 --strictPort',
        url: 'http://localhost:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
    },
    // channel: 'chrome' launches the system-installed Chrome instead
    // of Playwright's bundled Chromium 1217, because the bundled
    // Chromium does not supply a WebGPU adapter on Windows even with
    // --enable-unsafe-webgpu (verified 2026-04-30). System Chrome
    // ships WebGPU by default, which the smoothness e2e's WebGPU arm
    // requires.
    //
    // Trade-offs:
    //   - Reproducibility: system Chrome auto-updates, so different
    //     machines may run slightly different builds. Acceptable for
    //     a smoothness regression net; bumps in Chrome's frame pacing
    //     will surface as e2e drift, which is the right place to
    //     catch them.
    //   - Local prerequisite: Chrome must be installed on the dev
    //     machine. `pnpm test:e2e` fails with a clear "browser type
    //     'chromium' is not installed" message if missing; install
    //     via the OS-native channel.
    //   - CI: any CI environment running e2e needs Chrome installed.
    //     ubuntu-latest GitHub runners ship Chrome by default;
    //     windows-latest does not - if CI ever lands on Windows,
    //     wire `setup-chrome` or equivalent into the workflow.
    //   - Daily browsing: Playwright launches Chrome with a
    //     temporary user-data-dir, so test runs do not interfere
    //     with your normal Chrome session and vice versa.
    projects: [{name: 'chromium', use: {browserName: 'chromium', channel: 'chrome'}}],
});
