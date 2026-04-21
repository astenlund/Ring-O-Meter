import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';

// jsdom-hosted unit tests. Browser-only tests (*.browser.ts /
// *.browser.tsx) live under vitest.browser.config.ts and are excluded
// here so the jsdom runner does not choke on canvas /
// performance.memory / OffscreenCanvas.
export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        exclude: ['src/**/*.browser.ts', 'src/**/*.browser.tsx', 'node_modules/**'],
    },
});
