import {test} from '@playwright/test';
import {registerFakeAudioDevicesBeforeEach} from './support/fakeAudioDevices';
import {
    run60sSmoothnessProbe,
    withChordFanout,
    withTraceRenderer,
    TRACE_P99_FRAME_GAP_BUDGET_MS,
    TRACE_MAX_FRAME_GAP_BUDGET_MS,
    TRACE_GAP_OVER_VSYNC_BUDGET,
    TRACE_LONGTASK_BUDGET,
    TRACE_HEAP_DELTA_BUDGET_BYTES,
} from './support/smoothness';

// Dev-opt-in smoothness regression arm for the ?renderer=trace path.
// Trace was the production default before chord-aware-display shipped;
// it is now a dev-only renderer gated by devModesEnabled: true in
// /config.json. These arms preserve the trace renderer's pre-retirement
// budgets so a future change to the trace path can be measured against
// a stable baseline.
//
// This spec is NOT part of the standard `pnpm test:e2e` suite. Run
// explicitly when working on the trace renderer:
//
//   TRACE_RENDERER=1 pnpm --dir web exec playwright test e2e/trace-smoothness.spec.ts
//
// The spec injects devModesEnabled: true via page.route('/config.json')
// so ?renderer=trace is not silently ignored by the production-config
// fail-closed gate.

if (process.env.TRACE_RENDERER !== '1') {
    test.skip(
        true,
        'Trace-renderer arms are dev-opt-in. Set TRACE_RENDERER=1 to run.',
    );
}

registerFakeAudioDevicesBeforeEach();

// Inject devModesEnabled: true so ?renderer=trace is honoured rather
// than silently falling back to WebGPU default. Uses page.route
// (not a build-time constant) so the production bundle is unmodified.
test.beforeEach(async ({page}) => {
    await page.route('/config.json', (route) => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({hubUrl: '', devModesEnabled: true}),
        });
    });
});

// Trace-only arm options: preserved pre-retirement budgets + no vowel
// canvas check (the trace-only renderer suppresses vowel output by
// design — Task 22 passes traceOnly: true to suppress chord-bars and
// vowel modules, keeping only the pitch-trace lines).
const TRACE_ARM_OPTIONS = {
    p99FrameGapBudgetMs: TRACE_P99_FRAME_GAP_BUDGET_MS,
    maxFrameGapBudgetMs: TRACE_MAX_FRAME_GAP_BUDGET_MS,
    gapOverVsyncBudget: TRACE_GAP_OVER_VSYNC_BUDGET,
    longtaskBudget: TRACE_LONGTASK_BUDGET,
    heapDeltaBudgetBytes: TRACE_HEAP_DELTA_BUDGET_BYTES,
    skipVowelContentCheck: true,
};

const TRACE_ARM = {
    label: 'trace (dev-opt-in)',
    querystring: '',
    requiresAdapter: true,
} as const;

const FIXTURE_LABEL = 'dom7-sustained-trace';

test(`pitch plot is smooth for 60 seconds (dom7 sustained, ${TRACE_ARM.label})`, {
    tag: '@battery-sensitive',
}, async ({page}) => {
    const querystring = withChordFanout(withTraceRenderer(TRACE_ARM.querystring));
    await run60sSmoothnessProbe(page, FIXTURE_LABEL, TRACE_ARM, querystring, TRACE_ARM_OPTIONS);
});
