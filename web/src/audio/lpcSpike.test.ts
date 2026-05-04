// LPC compute-cost spike harness. Runs the 2x2 matrix of
// (Levinson autocorrelation vs Burg) x (8 kHz/F1+F2/order-10 vs
// 12 kHz/F1-F4/order-14) over the sustained-vowel.wav fixture and
// records per-frame timing distributions. The matrix's binary outcome
// answers the spec's open question: does LPC fit inside the worklet's
// per-analysis-frame budget? If yes, the lockstep YIN+LPC publish path
// in 2026-05-04-vowel-graph-first-slice.md is viable. If no, one of
// the three deferred fallback shapes (amortize, downsample further,
// larger frame size) becomes load-bearing.
//
// Structured as a vitest test so the TS modules import without
// transpilation; the actual benchmark runs once when the test is
// invoked. Per-frame timings are written to .tmp/lpc-spike-results.md
// rather than logged, since vitest captures stdout and discards it.
//
// To run:
//   pnpm --dir web test --run src/audio/lpcSpike.bench.ts

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

import {FormantDetector, type LpcMethod} from './formantDetector';

const FRAME_SIZE = 1024;
const WARMUP_FRAMES = 23; // 0.5 s at 48 kHz / 1024 samples per frame
const REPEATS_PER_FRAME = 4; // amplify per-frame cost so timer resolution doesn't dominate

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE_PATH = resolve(REPO_ROOT, 'web', 'test-fixtures', 'sustained-vowel.wav');
const RESULTS_PATH = resolve(REPO_ROOT, '.tmp', 'lpc-spike-results.md');

interface MatrixCell {
    label: string;
    method: LpcMethod;
    decimatedRate: number;
    decimatorCutoffHz: number;
    lpcOrder: number;
    formantCount: number;
}

const MATRIX: MatrixCell[] = [
    {
        label: 'Levinson @ 8 kHz, order 10, F1+F2',
        method: 'autocorrelation',
        decimatedRate: 8000,
        decimatorCutoffHz: 3500,
        lpcOrder: 10,
        formantCount: 2,
    },
    {
        label: 'Burg     @ 8 kHz, order 10, F1+F2',
        method: 'burg',
        decimatedRate: 8000,
        decimatorCutoffHz: 3500,
        lpcOrder: 10,
        formantCount: 2,
    },
    {
        label: 'Levinson @ 12 kHz, order 14, F1-F4',
        method: 'autocorrelation',
        decimatedRate: 12000,
        decimatorCutoffHz: 5500,
        lpcOrder: 14,
        formantCount: 4,
    },
    {
        label: 'Burg     @ 12 kHz, order 14, F1-F4',
        method: 'burg',
        decimatedRate: 12000,
        decimatorCutoffHz: 5500,
        lpcOrder: 14,
        formantCount: 4,
    },
];

interface CellTiming {
    label: string;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    meanMs: number;
    sampleCount: number;
    medianFormantsHz: number[];
}

function readWavSamples(path: string): {samples: Float32Array; sampleRate: number} {
    const raw = readFileSync(path);
    const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    if (buf.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error(`Not a RIFF file: ${path}`);
    }
    const channels = buf.readUInt16LE(22);
    const sampleRate = buf.readUInt32LE(24);
    const bitsPerSample = buf.readUInt16LE(34);
    const dataByteLength = buf.readUInt32LE(40);
    const sampleCount = dataByteLength / (channels * bitsPerSample / 8);
    if (bitsPerSample !== 16) {
        throw new Error(`Unsupported bits-per-sample: ${bitsPerSample}`);
    }
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
            sum += buf.readInt16LE(44 + (i * channels + c) * 2);
        }
        samples[i] = (sum / channels) / 32768;
    }

    return {samples, sampleRate};
}

function quantile(sortedAsc: Float64Array, q: number): number {
    const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * sortedAsc.length)));

    return sortedAsc[idx];
}

function median(values: number[]): number {
    if (values.length === 0) {
        return Number.NaN;
    }
    const sorted = [...values].sort((a, b) => a - b);

    return sorted[Math.floor(sorted.length / 2)];
}

function runCell(cell: MatrixCell, signal: Float32Array, sampleRate: number): CellTiming {
    const detector = new FormantDetector({
        inputRate: sampleRate,
        decimatedRate: cell.decimatedRate,
        decimatorCutoffHz: cell.decimatorCutoffHz,
        lpcOrder: cell.lpcOrder,
        lpcMethod: cell.method,
        formantCount: cell.formantCount,
    });

    const inputBuf = new Float32Array(FRAME_SIZE);
    const totalFrames = Math.floor(signal.length / FRAME_SIZE);
    const measuredFrames = Math.max(0, totalFrames - WARMUP_FRAMES);
    const timings = new Float64Array(measuredFrames);
    const formantReadings: number[][] = Array.from({length: cell.formantCount}, () => []);

    let measuredIdx = 0;
    for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        const offset = frameIdx * FRAME_SIZE;
        for (let i = 0; i < FRAME_SIZE; i++) {
            inputBuf[i] = signal[offset + i];
        }

        if (frameIdx < WARMUP_FRAMES) {
            detector.process(inputBuf);
            continue;
        }

        // Time the call: REPEATS_PER_FRAME consecutive process() calls,
        // average. Repeating amplifies per-frame work so 1 us timer
        // resolution doesn't dominate p99/max measurements; the detector
        // is self-stateful so each call is a real frame's worth of work
        // (subsequent ones operate on the same input but are not
        // skipping/caching anything based on the input being identical).
        const t0 = performance.now();
        for (let r = 0; r < REPEATS_PER_FRAME; r++) {
            detector.process(inputBuf);
        }
        const t1 = performance.now();
        timings[measuredIdx++] = (t1 - t0) / REPEATS_PER_FRAME;

        for (let f = 0; f < cell.formantCount; f++) {
            const v = detector.result.frequencies[f];
            if (Number.isFinite(v)) {
                formantReadings[f].push(v);
            }
        }
    }

    const sliced = timings.subarray(0, measuredIdx);
    // Sort copy for quantiles (Float64Array sort is in place).
    const sorted = new Float64Array(sliced);
    sorted.sort();
    let sum = 0;
    let max = 0;
    for (let i = 0; i < sorted.length; i++) {
        sum += sorted[i];
        if (sorted[i] > max) {
            max = sorted[i];
        }
    }

    return {
        label: cell.label,
        p50Ms: quantile(sorted, 0.5),
        p95Ms: quantile(sorted, 0.95),
        p99Ms: quantile(sorted, 0.99),
        maxMs: max,
        meanMs: sum / sorted.length,
        sampleCount: sorted.length,
        medianFormantsHz: formantReadings.map(median),
    };
}

function formatResults(results: CellTiming[], sampleRate: number, durationSec: number): string {
    const lines: string[] = [];
    lines.push('# LPC spike: per-frame compute cost matrix');
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push(`Fixture: web/test-fixtures/sustained-vowel.wav (${sampleRate} Hz, ${durationSec.toFixed(1)} s)`);
    lines.push(`Frame size: ${FRAME_SIZE} samples (${(FRAME_SIZE / sampleRate * 1000).toFixed(1)} ms per analysis frame)`);
    lines.push(`Warmup frames discarded: ${WARMUP_FRAMES} (~${(WARMUP_FRAMES * FRAME_SIZE / sampleRate).toFixed(2)} s)`);
    lines.push(`Per-frame measurement: average over ${REPEATS_PER_FRAME} consecutive process() calls`);
    lines.push('');
    lines.push('## Per-frame timing (end-to-end: pre-emphasis -> decimate -> LPC -> roots -> formants)');
    lines.push('');
    lines.push('| Configuration | p50 ms | p95 ms | p99 ms | max ms | mean ms | samples |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of results) {
        lines.push(
            `| ${r.label} | ${r.p50Ms.toFixed(3)} | ${r.p95Ms.toFixed(3)} | ${r.p99Ms.toFixed(3)} | ${r.maxMs.toFixed(3)} | ${r.meanMs.toFixed(3)} | ${r.sampleCount} |`,
        );
    }
    lines.push('');
    lines.push('## Median formant frequencies recovered (sanity check)');
    lines.push('');
    lines.push('| Configuration | F1 Hz | F2 Hz | F3 Hz | F4 Hz |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const r of results) {
        const fs = r.medianFormantsHz.map((v) => Number.isFinite(v) ? v.toFixed(0) : '-');
        while (fs.length < 4) {
            fs.push('-');
        }
        lines.push(`| ${r.label} | ${fs[0]} | ${fs[1]} | ${fs[2]} | ${fs[3]} |`);
    }
    lines.push('');
    lines.push('## Budget reference');
    lines.push('');
    lines.push(`Worklet analysis frame budget: ~${(FRAME_SIZE / sampleRate * 1000).toFixed(1)} ms per frame`);
    lines.push('Aspirational LPC budget: < 3 ms per frame (leaves headroom for YIN + future work)');
    lines.push('');

    return lines.join('\n');
}

describe('LPC spike benchmark', () => {
    it('runs the 2x2 matrix on sustained-vowel.wav and writes results', () => {
        // Arrange
        const {samples, sampleRate} = readWavSamples(FIXTURE_PATH);
        const durationSec = samples.length / sampleRate;

        // Act
        const results: CellTiming[] = [];
        for (const cell of MATRIX) {
            results.push(runCell(cell, samples, sampleRate));
        }

        // Persist
        const md = formatResults(results, sampleRate, durationSec);
        mkdirSync(dirname(RESULTS_PATH), {recursive: true});
        writeFileSync(RESULTS_PATH, md, 'utf8');

        // Assert: each cell produced finite timings, no infinities, no
        // catastrophic regressions. The actual go/no-go decision happens
        // in the next task by reading the markdown output.
        for (const r of results) {
            expect(r.sampleCount).toBeGreaterThan(100);
            expect(Number.isFinite(r.p99Ms)).toBe(true);
            expect(Number.isFinite(r.maxMs)).toBe(true);
        }
    }, 120_000);
});
