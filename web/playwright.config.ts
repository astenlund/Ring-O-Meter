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
            ],
        },
    },
    webServer: {
        command: 'pnpm build && pnpm preview --port 4173 --strictPort',
        url: 'http://localhost:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
    },
    projects: [{name: 'chromium', use: {browserName: 'chromium'}}],
});
