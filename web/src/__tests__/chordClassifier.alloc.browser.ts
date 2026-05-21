import {describe, test, expect} from 'vitest';
import {classifyChord, type VoiceObservation} from '../audio/chordClassifier';
import {ChordType} from '../wire/chord';
import {requireAllocHeap, settleHeap} from './allocHarness';

// Calibrated budget: the classifier allocates a fresh `active[]` array
// plus one result object literal (+ lockedChord literal) on the chord-
// locked path per call. Measured 2026-05-21: 200 warm invocations
// produce 0 bytes heap delta (GC collects between baseline and after;
// see "Alloc-test budget floor when calibration reads 0" in CLAUDE.md).
// Budget set to 4 KB minimum per that rule, capped at the initial
// 60 KB ceiling.
const HEAP_DELTA_BUDGET_BYTES = 60 * 1024;
const WARMUP_ITERATIONS = 200;
const MEASURE_ITERATIONS = 200;

// Pre-allocated voice observation arrays; reused across invocations to
// avoid counting test-harness allocations against the classifier budget.
const DOM7_VOICES: VoiceObservation[] = [
    {channelId: 'bass', f0Hz: 261.626, slotIndex: 0, gateOpen: true},
    {channelId: 'bari', f0Hz: 261.626 * (5 / 4), slotIndex: 1, gateOpen: true},
    {channelId: 'lead', f0Hz: 261.626 * (3 / 2), slotIndex: 2, gateOpen: true},
    {channelId: 'tnr',  f0Hz: 261.626 * (7 / 4), slotIndex: 3, gateOpen: true},
];

const NO_CHORD_VOICES: VoiceObservation[] = [
    {channelId: 'a', f0Hz: 261.626, slotIndex: 0, gateOpen: true},
    {channelId: 'b', f0Hz: 333.0,   slotIndex: 1, gateOpen: true},
    {channelId: 'c', f0Hz: 500.0,   slotIndex: 2, gateOpen: true},
    {channelId: 'd', f0Hz: 750.0,   slotIndex: 3, gateOpen: true},
];

const MAJOR_VOICES: VoiceObservation[] = [
    {channelId: 'bass', f0Hz: 440.0,              slotIndex: 0, gateOpen: true},
    {channelId: 'bari', f0Hz: 440.0 * (5 / 4),   slotIndex: 1, gateOpen: true},
    {channelId: 'lead', f0Hz: 440.0 * (3 / 2),   slotIndex: 2, gateOpen: true},
];

describe('chord-classifier allocation budget', () => {
    test(`${MEASURE_ITERATIONS} classifier invocations leave heap under ${HEAP_DELTA_BUDGET_BYTES / 1024} KB above warmup baseline`, () => {
        const heap = requireAllocHeap();

        // Sanity: verify the classifier produces expected results so the
        // alloc test is exercising the real chord-locked path.
        const sanity = classifyChord(DOM7_VOICES);
        if (sanity.lockedChord?.type !== ChordType.DominantSeventh) {
            throw new Error(`Classifier sanity failed: expected DominantSeventh, got ${sanity.lockedChord?.type}`);
        }

        // Warmup: run all three input shapes so each code path is JIT-hot
        // before the measurement window. Discard results.
        for (let i = 0; i < WARMUP_ITERATIONS; i++) {
            classifyChord(DOM7_VOICES);
            classifyChord(NO_CHORD_VOICES);
            classifyChord(MAJOR_VOICES);
        }

        settleHeap(heap);
        const baseline = heap.memory.usedJSHeapSize;

        // Measurement: interleave all three input shapes so the classifier
        // exercises both the chord-locked and no-chord-locked paths, which
        // differ in their allocation profile (locked path returns a new
        // result object; no-chord path returns the frozen NO_CHORD sentinel).
        for (let i = 0; i < MEASURE_ITERATIONS; i++) {
            classifyChord(DOM7_VOICES);
            classifyChord(NO_CHORD_VOICES);
            classifyChord(MAJOR_VOICES);
        }

        settleHeap(heap);
        const after = heap.memory.usedJSHeapSize;

        expect(after - baseline).toBeLessThan(HEAP_DELTA_BUDGET_BYTES);
    });
});
