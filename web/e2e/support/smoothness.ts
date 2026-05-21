import {expect, type CDPSession, type Page} from '@playwright/test';
import {createWriteStream, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertOnAcPower} from './acPower';

// Chrome DevTools Protocol categories for the optional in-test
// performance trace (CAPTURE_TRACE=1). Matches what DevTools'
// Performance panel records by default plus the
// disabled-by-default frame and v8 cpu profiler categories that
// surface compositor frame events and JS samples - the data we
// need to chase WebGPU max-frame-gap spikes back to their cause.
const TRACE_CATEGORIES = [
    'devtools.timeline',
    'blink',
    'cc',
    'gpu',
    'v8.execute',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-v8.cpu_profiler',
].join(',');

// Project-root .tmp/ directory (per CLAUDE.md's "use .tmp/ for
// scratch, not /tmp"). Resolves relative to this support file:
// support/smoothness.ts -> e2e/ -> web/ -> repo root.
const TRACE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.tmp');

// Per-CDP-IO.read chunk size in bytes (4 MiB). The default
// (32 KiB at the time of writing) makes a 200 MB trace drain
// require ~6,400 sequential CDP round-trips; 4 MiB drops that
// to ~50. Capped at 4 MiB rather than larger because the CDP
// transport buffers each response in memory before parsing,
// and ~4 MiB sits comfortably below typical V8 string limits.
const TRACE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

function armSlug(armLabel: string): string {
    return armLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Start a Chrome performance trace if CAPTURE_TRACE=1; returns a
// stop function that drains the trace stream to .tmp/trace-*.json
// once the measurement window completes. Returns null when tracing
// is not requested so the probe can early-return on the stop call
// without a special-case branch.
async function maybeStartTrace(
    page: Page,
    fixtureLabel: string,
    armLabel: string,
): Promise<(() => Promise<void>) | null> {
    if (process.env.CAPTURE_TRACE !== '1') {
        return null;
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Tracing.start', {
        transferMode: 'ReturnAsStream',
        categories: TRACE_CATEGORIES,
    });

    return async () => stopTrace(cdp, fixtureLabel, armLabel);
}

async function stopTrace(
    cdp: CDPSession,
    fixtureLabel: string,
    armLabel: string,
): Promise<void> {
    // Tracing.tracingComplete fires after Chrome has finalised the
    // buffer; it carries the stream handle. Tracing.end does NOT
    // return the handle directly - subscribing to the event before
    // calling end is what catches it.
    const streamPromise = new Promise<string>((resolve) => {
        cdp.once('Tracing.tracingComplete', (event: {stream?: string}) => {
            resolve(event.stream ?? '');
        });
    });
    await cdp.send('Tracing.end');
    const handle = await streamPromise;
    if (!handle) {
        await cdp.detach();
        return;
    }
    mkdirSync(TRACE_DIR, {recursive: true});
    const path = join(TRACE_DIR, `trace-${fixtureLabel}-${armSlug(armLabel)}.json`);
    const out = createWriteStream(path);
    // Surface mid-drain disk errors (e.g. disk full) instead of
    // silently swallowing them. Without this, out.write returns
    // false, the loop continues, and the only signal of failure
    // is a possibly-truncated file with no diagnostic.
    const writeErrors: Error[] = [];
    out.on('error', (err) => {
        writeErrors.push(err);
    });
    try {
        for (;;) {
            const {data, eof, base64Encoded} = await cdp.send('IO.read', {
                handle,
                size: TRACE_READ_CHUNK_BYTES,
            }) as {
                data: string;
                eof: boolean;
                base64Encoded?: boolean;
            };
            // For Tracing streams Chrome currently returns plain JSON
            // text (base64Encoded undefined / false), but the CDP spec
            // permits base64 - decode defensively so a future Chrome
            // change doesn't silently produce un-loadable trace files.
            out.write(base64Encoded ? Buffer.from(data, 'base64') : data);
            if (eof) {
                break;
            }
        }
        await cdp.send('IO.close', {handle});
        await new Promise<void>((resolve, reject) => {
            out.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
        if (writeErrors.length > 0) {
            throw writeErrors[0];
        }
    } finally {
        // Detach the CDP session even if drain failed mid-stream;
        // Playwright would close it on page teardown, but explicit
        // detach is cheap and removes the leak window.
        await cdp.detach();
    }

    console.log(`[trace] wrote ${path}`);
}

// Shared bits for the 60-second smoothness regression net. Hosts the
// budgets, the renderer-arm parameterisation, the fake-audio
// beforeEach shim, and the probe body. Imported by both
// `smoothness.spec.ts` (sustained-tone fixture, the global
// playwright.config.ts audioFile) and
// `staccato-smoothness.spec.ts` (staccato-tone fixture, top-level
// test.use launchOptions override).

// heuristic: smoothness-budget
export const OBSERVATION_MS = 60_000;
// heuristic: smoothness-budget
// TODO: re-baseline against new chord-bars + vowel mix after 3 green CI runs
export const P99_FRAME_GAP_BUDGET_MS = 20;
// heuristic: smoothness-budget
// TODO: re-baseline against new chord-bars + vowel mix after 3 green CI runs
export const MAX_FRAME_GAP_BUDGET_MS = 50;
// heuristic: smoothness-budget
export const LONGTASK_BUDGET = 0;
// heuristic: smoothness-budget
// 600 KB = measured_clean_run * ~1.6 (two local runs at ~370 KB,
// ~1% variance). This e2e delta measures the whole app's 60 s
// churn - React reconciles from useFrameState flushes, rAF closures,
// V8 heap-ratchet slack, FrameRingReader.readLatestFormants's
// FormantFrame writes - NOT just the per-frame pipeline that the per-module
// alloc tests cover in isolation. Do not calibrate this by summing
// the per-module budgets; those answer a narrower question. Target
// per the hot-path-allocation-discipline pattern:
// `measured_clean_run * 1.5` after three green CI runs. Ratchet
// down only when a churn-reduction change has landed AND three CI
// runs confirm the new baseline.
// TODO: re-baseline against new chord-bars + vowel mix after 3 green CI runs
export const HEAP_DELTA_BUDGET_BYTES = 600 * 1024;
// heuristic: smoothness-budget
// Threshold for "missed at least one vsync" at 60 Hz (16.667 ms +
// small noise margin). Drives GAP_OVER_VSYNC_BUDGET below.
export const GAP_OVER_VSYNC_THRESHOLD_MS = 17;
// heuristic: smoothness-budget
// Counts gaps in the test's own rAF chain (one tick per vsync) that
// exceed the threshold; this is the "did MY chain miss its slot"
// metric. NOT the same as trace-based outlier counts which include
// every rAF chain on main and run at ~2x the test rate.
// Measured baselines (two multi-arm runs @ 60 s, post-NoteReadout
// fix): WebGPU sustained 36-51, 2D sustained 20-48, WebGPU staccato
// 22-41, 2D staccato 27-40. Per-arm run-to-run spread is up to 2x
// (the GPU pipeline state varies between cold runs in ways the test
// can't control). 100 = worst observed * 2; conservative initial
// setting chosen for variance tolerance over tightness, ratchet
// down per the hot-path-allocation-discipline convention (target:
// 60 = measured * 1.2 once variance settles or a churn-reduction
// change lands). Locks in the NoteReadout cached-last-valid-pitch
// fix and the frame-rate-dom-mutation-discipline pattern derived
// from the staccato GPU-outlier investigation: a future regression
// that rolls back the text-cache discipline (or breaks discipline 1
// in a new component) would push the worst arm past 100.
// TODO: re-baseline against new chord-bars + vowel mix after 3 green CI runs
export const GAP_OVER_VSYNC_BUDGET = 100;

// Renderer arms for the parameterised smoothness test. As of
// 2026-05-21 the 2D canvas is the production default while WebGPU
// completes optimization work; the WebGPU arm is opt-in via
// ?renderer=webgpu. Both arms are real production paths and the
// smoothness budgets apply to both. `requiresAdapter` gates the
// navigator.gpu.requestAdapter() precondition in setupSmoothnessPage
// so the WebGPU arm fails fast on hosts that lack a usable adapter.
export const RENDERER_ARMS = [
    {label: '2D canvas (default)', querystring: '', requiresAdapter: false},
    {label: 'WebGPU (opt-in)', querystring: '?renderer=webgpu', requiresAdapter: true},
] as const;

export type RendererArm = typeof RENDERER_ARMS[number];

// Structural supertype accepted by setupSmoothnessPage and
// run60sSmoothnessProbe. RendererArm is a narrow const-typed
// subtype; SmoothnessArm is the shape the probe functions actually
// need, allowing callers (e.g. trace-smoothness.spec.ts) to pass
// custom arms without being constrained to the RendererArm literal
// union.
export interface SmoothnessArm {
    readonly label: string;
    readonly querystring: string;
    readonly requiresAdapter: boolean;
}

// 4-voice "barbershop seven" chord, expressed as typed constants
// rather than a single opaque query string. The CHORD_OFFSETS
// tuple's length is enforced at compile time via `as const`, and
// CHORD_FANOUT_QUERY is composed from the typed shapes below so
// `fanout=N` and the offsets list cannot drift independently.
//
// JI cent offsets computed from the exact ratios so the chord-aware
// classifier sees zero per-voice residual (integer-cent
// approximations like 386 / 702 / 969 leave -0.31 / +0.04 / +0.17
// residuals because the classifier targets ratio-precise cents):
//   Root       (1/1):                       0 cents -> 220 Hz (A3)
//   Maj 3rd    (5/4): 1200 * log2(5/4) ≈ 386.31 cents -> 275 Hz (C#4)
//   Perfect 5  (3/2): 1200 * log2(3/2) ≈ 701.96 cents -> 330 Hz (E4)
//   Harmonic 7 (7/4): 1200 * log2(7/4) ≈ 968.83 cents -> 385 Hz (G4)
//
// Harmonic 7 rather than equal-tempered minor 7 (1000 cents) because
// that is the barbershop tuning convention and what makes the chord
// lock. All four pitches fit inside the plot's [80, 600] Hz window.
// Uses the existing fanout test mode (web/src/__testing/fanoutFlag.ts):
// one physical mic feeds N VoiceChannels, each with a per-channel
// pitch multiplier applied at the worklet's publish step. YIN runs
// once on the shared input; the multipliers transform only the
// published Hz value.
const CHORD_OFFSETS = [
    0,
    1200 * Math.log2(5 / 4),
    1200 * Math.log2(3 / 2),
    1200 * Math.log2(7 / 4),
] as const;
const CHORD_FANOUT_COUNT = CHORD_OFFSETS.length;
const CHORD_FANOUT_QUERY = `fanout=${CHORD_FANOUT_COUNT}&offsets=${CHORD_OFFSETS.join(',')}`;

// Compose the fanout query with a renderer arm's querystring.
// arm.querystring is either '' (2D default) or '?renderer=webgpu'
// (WebGPU opt-in); the returned string starts with '?' and combines
// both via '&'.
export function withChordFanout(armQuerystring: string): string {
    return armQuerystring === ''
        ? `?${CHORD_FANOUT_QUERY}`
        : `${armQuerystring}&${CHORD_FANOUT_QUERY}`;
}

// Appends &renderer=trace (or starts with ?renderer=trace when the
// input is empty). Used by the dev-opt-in trace arm in
// trace-smoothness.spec.ts. The trace renderer requires
// devModesEnabled: true in /config.json; the spec file injects this
// via page.route('/config.json') before navigating.
export function withTraceRenderer(querystring: string): string {
    return querystring === ''
        ? '?renderer=trace'
        : `${querystring}&renderer=trace`;
}

// Budget constants for the dev-opt-in trace arm. These preserve the
// trace renderer's original calibration from before chord-aware-display
// shipped; the trace path no longer runs in production, so these
// numbers are not subject to the chord-bars + vowel mix re-baseline.
// heuristic: smoothness-budget
export const TRACE_P99_FRAME_GAP_BUDGET_MS = 20;
// heuristic: smoothness-budget
export const TRACE_MAX_FRAME_GAP_BUDGET_MS = 50;
// heuristic: smoothness-budget
export const TRACE_LONGTASK_BUDGET = 0;
// heuristic: smoothness-budget
export const TRACE_HEAP_DELTA_BUDGET_BYTES = 600 * 1024;
// heuristic: smoothness-budget
export const TRACE_GAP_OVER_VSYNC_BUDGET = 100;

// Page-level setup shared between the 60-second smoothness probe
// and the opt-in 30-minute long-window arm: refuses on battery
// (assertOnAcPower), navigates to the renderer-arm-specific URL,
// hard-asserts WebGPU adapter availability for arms that require
// it, clicks Start, waits for the canvas to mount, and gives the
// worklet 5000 ms to settle before the caller's measurement
// window begins.
//
// Extracted from run60sSmoothnessProbe so the long-window arm
// (smoothness.spec.ts under PROTOTYPE_LONG=1) does not duplicate
// the precondition / setup code it shares with the 60-second
// arms. The two arms differ only in the measurement loop body.
export async function setupSmoothnessPage(
    page: Page,
    arm: SmoothnessArm,
    querystring: string,
): Promise<void> {
    // Placed before page.goto so battery-throttled hosts are rejected before any browser work begins.
    assertOnAcPower();
    await page.goto(`/${querystring}`);

    if (arm.requiresAdapter) {
        // navigator.gpu is non-null on stock Chromium regardless
        // of --enable-unsafe-webgpu; the flag affects what
        // requestAdapter() returns on Windows. Probe the adapter
        // directly so a missing flag (or otherwise-broken WebGPU)
        // hard-fails the test instead of silently rubber-stamping
        // the comparison against a worker whose init() threw.
        const hasAdapter = await page.evaluate(async () => {
            if (!navigator.gpu) {
                return false;
            }
            const adapter = await navigator.gpu.requestAdapter();

            return adapter !== null;
        });
        expect(
            hasAdapter,
            'WebGPU arm requires a usable adapter; check Playwright Chromium launch args (--enable-unsafe-webgpu) and host WebGPU support',
        ).toBe(true);
    }

    // DeviceSetup renders a single "Start" button once two audio
    // inputs are visible. Wait for it with a generous timeout because
    // the probe getUserMedia() call plus enumerateDevices() takes a
    // moment on first page load.
    const startButton = page.getByRole('button', {name: /^start$/i});
    await expect(startButton).toBeVisible({timeout: 15_000});
    await startButton.click();
    // Two canvases (underlay + main) when useUnderlay is true on
    // the WebGPU arm; .first() matches either shape.
    await expect(page.locator('canvas').first()).toBeVisible();
    // 5000 ms warmup absorbs the Dawn/Skia first-time pipeline
    // warmup that the cold-start-judder bug entry (Fixed in BUGS.md
    // 2026-04-29) noted as "brief sub-second cold-start judder may
    // persist." Empirically the previous 1500 ms warmup left the
    // first ~3 s of measurement noisy, producing intermittent
    // 100 ms+ freezes in multi-arm runs (sustained-WebGPU as the
    // first arm). Cleaner-than-1500 ms data: solo runs and
    // CAPTURE_TRACE-enabled multi-arm runs (the latter adds CDP
    // setup time per arm, effectively extending warmup). 5000 ms
    // brings multi-arm-no-trace runs into the same clean envelope.
    await page.waitForTimeout(5000);
}

// Options for overriding probe behaviour. All fields are optional;
// defaults preserve the standard-suite behaviour so existing callers
// need no changes. Used by the dev-opt-in trace arm
// (trace-smoothness.spec.ts) which runs with its own budget constants
// and skips the vowel-canvas content check (trace-only renderer
// suppresses vowel output).
export interface SmoothnessProbeOptions {
    /** Override p99 frame-gap budget (ms). Defaults to P99_FRAME_GAP_BUDGET_MS. */
    p99FrameGapBudgetMs?: number;
    /** Override max frame-gap budget (ms). Defaults to MAX_FRAME_GAP_BUDGET_MS. */
    maxFrameGapBudgetMs?: number;
    /** Override gapsOverVsync budget. Defaults to GAP_OVER_VSYNC_BUDGET. */
    gapOverVsyncBudget?: number;
    /** Override longtask budget. Defaults to LONGTASK_BUDGET. */
    longtaskBudget?: number;
    /** Override heap-delta budget (bytes). Defaults to HEAP_DELTA_BUDGET_BYTES. */
    heapDeltaBudgetBytes?: number;
    /** When true, skips the vowel-canvas content assertion. Defaults to false. */
    skipVowelContentCheck?: boolean;
}

// 60-second smoothness probe shared between the sustained and
// staccato fixture spec files. Same precondition (WebGPU adapter
// check on the WebGPU arm), same measurement, same budgets; only
// the audio-capture file (and therefore the singing waveform
// reaching the YIN detector) differs across callers.
export async function run60sSmoothnessProbe(
    page: Page,
    fixtureLabel: string,
    arm: SmoothnessArm,
    querystring: string,
    options: SmoothnessProbeOptions = {},
): Promise<void> {
    await setupSmoothnessPage(page, arm, querystring);

    // Optional Chrome performance trace covering the measurement
    // window. Gated behind CAPTURE_TRACE=1 because traces are large
    // (~50-200 MB per arm). Loose .tmp/trace-*.json files for
    // loading directly into Chrome DevTools' Performance panel.
    const stopTrace = await maybeStartTrace(page, fixtureLabel, arm.label);

    const result = await page.evaluate(async (config: {
        observationMs: number;
        gapOverVsyncThresholdMs: number;
    }) => {
        interface PerfWithMemory extends Performance {
            memory?: {usedJSHeapSize: number};
        }
        const perfMem = performance as PerfWithMemory;
        const supportsMemory = Boolean(perfMem.memory);
        const supportsGc = typeof (globalThis as {gc?: () => void}).gc === 'function';

        if (supportsGc) {
            (globalThis as {gc?: () => void}).gc!();
        }
        const heapBaseline = supportsMemory ? perfMem.memory!.usedJSHeapSize : 0;

        const gaps: number[] = [];
        const longtasks: number[] = [];
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                longtasks.push(entry.duration);
            }
        });
        observer.observe({entryTypes: ['longtask']});

        let lastTs = performance.now();
        const startTs = lastTs;
        await new Promise<void>((resolve) => {
            const tick = (ts: number) => {
                gaps.push(ts - lastTs);
                lastTs = ts;
                if (ts - startTs < config.observationMs) {
                    requestAnimationFrame(tick);

                    return;
                }
                resolve();
            };
            requestAnimationFrame(tick);
        });
        observer.disconnect();

        if (supportsGc) {
            (globalThis as {gc?: () => void}).gc!();
        }
        const heapAfter = supportsMemory ? perfMem.memory!.usedJSHeapSize : 0;

        gaps.sort((a, b) => a - b);
        const p99 = gaps[Math.floor(gaps.length * 0.99)] ?? 0;
        const max = gaps[gaps.length - 1] ?? 0;
        // Sorted ascending; missed-vsync count is everything above the
        // threshold. Walking from the end stops as soon as a sample
        // falls under the threshold, so the cost is O(misses) not
        // O(gaps).
        let gapsOverVsync = 0;
        for (let i = gaps.length - 1; i >= 0; i -= 1) {
            if (gaps[i] <= config.gapOverVsyncThresholdMs) {
                break;
            }
            gapsOverVsync += 1;
        }

        return {
            p99,
            max,
            gapCount: gaps.length,
            gapsOverVsync,
            longtaskCount: longtasks.length,
            heapDelta: supportsMemory ? heapAfter - heapBaseline : -1,
            heapMeasured: supportsMemory,
        };
    }, {observationMs: OBSERVATION_MS, gapOverVsyncThresholdMs: GAP_OVER_VSYNC_THRESHOLD_MS});

    // Stop the trace (if started) before the assertions so the
    // file is on disk regardless of whether a budget assertion
    // fails. A failed assertion that aborts the test would
    // otherwise leave the CDP session leaking and the trace
    // unwritten - which is exactly the case where we'd most want
    // the trace.
    if (stopTrace !== null) {
        await stopTrace();
    }

    // Per-fixture-per-arm reporter line: feeds the spec's
    // "Prototype results" section.

    console.log(`[smoothness:${fixtureLabel}:${arm.label}] p99=${result.p99}ms max=${result.max}ms gapsOverVsync=${result.gapsOverVsync} longtasks=${result.longtaskCount} heapDelta=${result.heapDelta}B`);

    // Hard-fail on an empty rAF stream: result.p99 / result.max
    // both fall back to 0 when no gaps were collected, which would
    // otherwise pass the < 20 / < 50 ms budgets silently. A 60 s
    // observation window with zero rAF callbacks means the page
    // never rendered (fatal init error, navigation timeout, etc.)
    // and the test should not green-stamp that.
    expect(
        result.gapCount,
        '60 s observation window produced zero rAF callbacks - the page never rendered',
    ).toBeGreaterThan(0);

    const p99Budget = options.p99FrameGapBudgetMs ?? P99_FRAME_GAP_BUDGET_MS;
    const maxBudget = options.maxFrameGapBudgetMs ?? MAX_FRAME_GAP_BUDGET_MS;
    const vsyncBudget = options.gapOverVsyncBudget ?? GAP_OVER_VSYNC_BUDGET;
    const longtaskBudget = options.longtaskBudget ?? LONGTASK_BUDGET;
    const heapBudget = options.heapDeltaBudgetBytes ?? HEAP_DELTA_BUDGET_BYTES;

    expect(result.p99).toBeLessThan(p99Budget);
    expect(result.max).toBeLessThan(maxBudget);
    expect(result.gapsOverVsync).toBeLessThan(vsyncBudget);
    expect(result.longtaskCount).toBe(longtaskBudget);
    if (result.heapMeasured) {
        expect(result.heapDelta).toBeLessThan(heapBudget);
    }

    // Content assertion: the timing budgets above can pass while the
    // canvases show nothing (e.g. silent encoder.finish() throws after
    // a missed WebGPU validation rule, render passes opened against
    // 0x0 swap-chain textures, vowel-module roster never seeded). The
    // rAF callback returns in time and the test green-stamps blank
    // pixels. Count "coloured" pixels (R/G/B saturation > 30) so the
    // background fill (#0a0a0a) and grey gridlines (#222) don't flatter
    // the count: only voice-coloured trace lines and polygon
    // strokes/dots qualify. An empty canvas reports 0; either bug
    // class above drops the count to that floor.
    //
    // Trace gets a generous threshold (50): a single trace line at
    // 60 fps × 60 s × ~1-px stroke clears that easily.
    //
    // The vowel threshold is much tighter (4). The empirical floor is
    // sub-pixel-noisy because of how the dom7 fanout interacts with the
    // sustained-vowel.wav fixture: fanoutWorklet shares one formant
    // detector across the four voices (vocal tract is shared since it's
    // one mic), so polygon vertices coincide and edges contribute no
    // pixels. The visible content is one stacked 4×4 device-pixel dot
    // (Playwright's default viewport runs at dpr=1, so VOWEL_DOT_CSS_SIZE
    // × dpr = 4 × 1 = 4). LPC fitted to the harmonic stack picks F2 ≈
    // F2_MIN = 700 Hz (the fixture's strong harmonic right at the edge
    // of the plot's F2 range), which sends the projection
    // `x = width × (1 - (f2Hz - F2_MIN) / F2_SPAN)` to ≈ width — landing
    // the dot square on the right canvas edge. Frame-to-frame F2 jitter
    // of ±20 Hz around 700 shifts the dot in/out of the canvas, making
    // the visible-pixel count vary 4–16. Threshold 4 catches the
    // bug-detection floor (count = 0 for blank canvas / dot fully
    // off-canvas / polygon collapsed) while tolerating the edge jitter.
    // Switching to vowel-with-formants.wav (F2=1100, mid-plot) would
    // eliminate the jitter and let us tighten the threshold, but that
    // fixture is reserved for the robust-formant-pipeline feature.
    // Vowel-canvas content check is skipped for the staccato fixture:
    // gen-staccato-audio.mjs produces a pure 220 Hz sine with no
    // harmonic structure, so LPC formant detection returns sentinel
    // zeros and consumeLatestFrame leaves the per-channel f1Hz/f2Hz at
    // their initial value of 0 (which maps off-canvas under the
    // `width * (1 - (0 - F2_MIN) / F2_SPAN)` projection). The fixture
    // was designed to exercise gate-flip rendering load at ~3 Hz, not
    // to produce vowel content. The trace check still runs — YIN
    // detects 220 Hz cleanly inside the plot's [80, 600] Hz window.
    // skipVowelContentCheck is used by the dev-opt-in trace arm, whose
    // trace-only renderer suppresses vowel output by design.
    const checkVowel = !options.skipVowelContentCheck && fixtureLabel !== 'dom7-staccato';
    await assertCanvasesHaveContent(page, checkVowel);
}

async function assertCanvasesHaveContent(page: Page, checkVowel: boolean): Promise<void> {
    const roles = checkVowel ? ['trace', 'vowel'] : ['trace'];
    const counts = await page.evaluate((rolesArg) => {
        const samples: Record<string, number> = {};
        for (const role of rolesArg) {
            const canvas = document.querySelector(`canvas[data-role="${role}"]`) as HTMLCanvasElement | null;
            if (!canvas) {
                samples[role] = -1;

                continue;
            }
            // Use the placeholder canvas's intrinsic pixel dimensions
            // (set by the worker after transferControlToOffscreen). For
            // both 2D and WebGPU paths the placeholder reflects the
            // worker's most recent commit; drawImage into a same-origin
            // OffscreenCanvas pulls those pixels without taint.
            const w = canvas.width;
            const h = canvas.height;
            if (w === 0 || h === 0) {
                samples[role] = -1;

                continue;
            }
            const tmp = new OffscreenCanvas(w, h);
            const ctx = tmp.getContext('2d');
            if (!ctx) {
                samples[role] = -1;

                continue;
            }
            ctx.drawImage(canvas, 0, 0);
            const data = ctx.getImageData(0, 0, w, h).data;
            let colored = 0;
            for (let i = 0; i < data.length; i += 4) {
                const max = Math.max(data[i], data[i + 1], data[i + 2]);
                const min = Math.min(data[i], data[i + 1], data[i + 2]);
                if (max - min > 30) {
                    colored += 1;
                }
            }
            samples[role] = colored;
        }

        return samples;
    }, roles);
    // Negative sentinel (-1) means the canvas was not found or had zero
    // device-pixel dimensions — a distinct failure from "canvas found but
    // no coloured pixels." Different error messages help distinguish them.
    expect(counts.trace, counts.trace < 0
        ? 'trace canvas: not found in page realm or has zero device-pixel dimensions'
        : `trace canvas: too few coloured pixels (${counts.trace}; expected > 50)`,
    ).toBeGreaterThan(50);
    if (checkVowel) {
        expect(counts.vowel, counts.vowel < 0
            ? 'vowel canvas: not found in page realm or has zero device-pixel dimensions'
            : `vowel canvas: too few coloured pixels (${counts.vowel}; expected > 4)`,
        ).toBeGreaterThan(4);
    }
}
