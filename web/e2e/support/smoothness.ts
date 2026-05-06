import {expect, type CDPSession, type Page} from '@playwright/test';
import {createWriteStream, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

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
export const P99_FRAME_GAP_BUDGET_MS = 20;
// heuristic: smoothness-budget
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
export const GAP_OVER_VSYNC_BUDGET = 100;

// Renderer arms for the parameterised smoothness test. As of
// 2026-04-30 WebGPU is the production default; the 2D arm is the
// opt-out fallback selected via ?renderer=2d. Both arms are real
// production paths now and the smoothness budgets apply to both.
// `requiresAdapter` gates the navigator.gpu.requestAdapter()
// precondition in setupSmoothnessPage so the WebGPU arm fails
// fast on hosts that lack a usable adapter.
export const RENDERER_ARMS = [
    {label: 'WebGPU (default)', querystring: '', requiresAdapter: true},
    {label: '2D canvas (opt-out)', querystring: '?renderer=2d', requiresAdapter: false},
] as const;

export type RendererArm = typeof RENDERER_ARMS[number];

// 4-voice "barbershop seven" chord, expressed as typed constants
// rather than a single opaque query string. The CHORD_OFFSETS
// tuple's length is enforced at compile time via `as const`, and
// CHORD_FANOUT_QUERY is composed from the typed shapes below so
// `fanout=N` and the offsets list cannot drift independently.
//
// JI cent offsets from the root (A3, 220 Hz):
//   Root       (1/1):   0 cents -> 220 Hz (A3)
//   Maj 3rd    (5/4): 386 cents -> 275 Hz (C#4)
//   Perfect 5  (3/2): 702 cents -> 330 Hz (E4)
//   Harmonic 7 (7/4): 969 cents -> 385 Hz (G4)
//
// Harmonic 7 (969 cents) rather than equal-tempered minor 7
// (1000 cents) because that is the barbershop tuning convention
// and what makes the chord lock. All four pitches fit inside the
// plot's [80, 600] Hz window. Uses the existing fanout test mode
// (web/src/__testing/fanoutFlag.ts): one physical mic feeds N
// VoiceChannels, each with a per-channel pitch multiplier applied
// at the worklet's publish step. YIN runs once on the shared
// input; the multipliers transform only the published Hz value.
const CHORD_OFFSETS = [0, 386, 702, 969] as const;
const CHORD_FANOUT_COUNT = CHORD_OFFSETS.length;
const CHORD_FANOUT_QUERY = `fanout=${CHORD_FANOUT_COUNT}&offsets=${CHORD_OFFSETS.join(',')}`;

// Compose the fanout query with a renderer arm's querystring.
// arm.querystring is either '' (WebGPU default) or '?renderer=2d'
// (2D opt-out); the returned string starts with '?' and combines
// both via '&'.
export function withChordFanout(armQuerystring: string): string {
    return armQuerystring === ''
        ? `?${CHORD_FANOUT_QUERY}`
        : `${armQuerystring}&${CHORD_FANOUT_QUERY}`;
}

// Page-level setup shared between the 60-second smoothness probe
// and the opt-in 30-minute long-window arm: navigates to the
// renderer-arm-specific URL, hard-asserts WebGPU adapter
// availability for arms that require it, clicks Start, waits for
// the canvas to mount, and gives the worklet 1500 ms to settle
// before the caller's measurement window begins.
//
// Extracted from run60sSmoothnessProbe so the long-window arm
// (smoothness.spec.ts under PROTOTYPE_LONG=1) does not duplicate
// the precondition / setup code it shares with the 60-second
// arms. The two arms differ only in the measurement loop body.
export async function setupSmoothnessPage(
    page: Page,
    arm: RendererArm,
    querystring: string,
): Promise<void> {
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

// 60-second smoothness probe shared between the sustained and
// staccato fixture spec files. Same precondition (WebGPU adapter
// check on the WebGPU arm), same measurement, same budgets; only
// the audio-capture file (and therefore the singing waveform
// reaching the YIN detector) differs across callers.
export async function run60sSmoothnessProbe(
    page: Page,
    fixtureLabel: string,
    arm: RendererArm,
    querystring: string,
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

    expect(result.p99).toBeLessThan(P99_FRAME_GAP_BUDGET_MS);
    expect(result.max).toBeLessThan(MAX_FRAME_GAP_BUDGET_MS);
    expect(result.gapsOverVsync).toBeLessThan(GAP_OVER_VSYNC_BUDGET);
    expect(result.longtaskCount).toBe(LONGTASK_BUDGET);
    if (result.heapMeasured) {
        expect(result.heapDelta).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);
    }
}
