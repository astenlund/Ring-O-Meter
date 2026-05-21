import {describe, expect, it} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {act} from 'react';
import {useChordClassification, type ChordClassificationResult, type SlotDescriptor} from './useChordClassification';
import type {FormantFrame} from './frameRing';
import {ChordType} from '../wire/chord';

// ---- Test harness ----------------------------------------------------------

interface ProbeRef {
    result: ChordClassificationResult | null;
}

interface HarnessProps {
    latest: Record<string, FormantFrame>;
    slots: ReadonlyArray<SlotDescriptor>;
    probeRef: ProbeRef;
}

function Harness({latest, slots, probeRef}: HarnessProps): null {
    probeRef.result = useChordClassification(latest, slots);

    return null;
}

// Build a FormantFrame with only the fields the hook cares about.
function frame(fundamentalHz: number, confidence = 0.9): FormantFrame {
    return {fundamentalHz, confidence, rmsDb: -20, f1Hz: 0, f2Hz: 0, f3Hz: 0, f4Hz: 0};
}

// JI dom7 chord frequencies rooted at C4 (261.626 Hz).
const C4 = 261.626;

// Each call produces a fresh object reference, simulating useFrameState's
// buffer-flip: the hook's useMemo sees a new `latest` reference each
// "frame" and recomputes observations, which triggers the useEffect.
const makeDom7Latest = (): Record<string, FormantFrame> => ({
    bass: frame(C4),
    bari: frame(C4 * 5 / 4),
    lead: frame(C4 * 3 / 2),
    tnr: frame(C4 * 7 / 4),
});

const dom7Slots: SlotDescriptor[] = [
    {channelId: 'bass', slotIndex: 0},
    {channelId: 'bari', slotIndex: 1},
    {channelId: 'lead', slotIndex: 2},
    {channelId: 'tnr', slotIndex: 3},
];

// ---- Helpers ----------------------------------------------------------------

async function mountHarness(
    container: HTMLElement,
    root: Root,
    latest: Record<string, FormantFrame>,
    slots: ReadonlyArray<SlotDescriptor>,
    probeRef: ProbeRef,
): Promise<void> {
    await act(async () => {
        root.render(<Harness latest={latest} slots={slots} probeRef={probeRef} />);
    });
}

async function rerender(
    root: Root,
    latest: Record<string, FormantFrame>,
    slots: ReadonlyArray<SlotDescriptor>,
    probeRef: ProbeRef,
): Promise<void> {
    await act(async () => {
        root.render(<Harness latest={latest} slots={slots} probeRef={probeRef} />);
    });
}

// ---- Tests ------------------------------------------------------------------

describe('useChordClassification', () => {
    it('returns no-chord-locked initially (no data)', async () => {
        const probeRef: ProbeRef = {result: null};
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await mountHarness(container, root, {}, [], probeRef);

        expect(probeRef.result?.lockedChord).toBeNull();

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('does not lock a chord on the first matching frame (hysteresis requires 2)', async () => {
        const probeRef: ProbeRef = {result: null};
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        // First render: dom7 input.
        await mountHarness(container, root, makeDom7Latest(), dom7Slots, probeRef);

        // Hysteresis requires HYSTERESIS_FRAMES=2 matching frames;
        // the first frame starts as candidate at counter=1, so lock
        // must not be set yet.
        expect(probeRef.result?.lockedChord).toBeNull();

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('locks a dom7 chord after 2 consecutive matching frames', async () => {
        const probeRef: ProbeRef = {result: null};
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        // Frame 1: dom7 — starts as candidate (counter=1).
        await mountHarness(container, root, makeDom7Latest(), dom7Slots, probeRef);
        expect(probeRef.result?.lockedChord).toBeNull();

        // Frame 2: same dom7 values, new `latest` reference (simulates
        // useFrameState's buffer-flip) — counter reaches HYSTERESIS_FRAMES=2.
        await rerender(root, makeDom7Latest(), dom7Slots, probeRef);
        expect(probeRef.result?.lockedChord?.type).toBe(ChordType.DominantSeventh);
        expect(probeRef.result?.lockedChord?.rootChannelId).toBe('bass');

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('preserves the lock through a single outlier frame (1-frame outlier is debounced)', async () => {
        const probeRef: ProbeRef = {result: null};
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        // Frames 1-2: lock dom7.
        await mountHarness(container, root, makeDom7Latest(), dom7Slots, probeRef);
        await rerender(root, makeDom7Latest(), dom7Slots, probeRef);
        expect(probeRef.result?.lockedChord?.type).toBe(ChordType.DominantSeventh);

        // Frame 3: single outlier (tnr voice detuned far from 7:4).
        const outlier = makeDom7Latest();
        outlier.tnr = frame(C4 * 7 / 4 * 1.1);
        await rerender(root, outlier, dom7Slots, probeRef);

        // Lock must persist — one mismatching frame does not break it.
        expect(probeRef.result?.lockedChord?.type).toBe(ChordType.DominantSeventh);

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('transitions to a new chord after 2 consecutive matching frames of the new type', async () => {
        const probeRef: ProbeRef = {result: null};
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        // Lock dom7 over frames 1-2.
        await mountHarness(container, root, makeDom7Latest(), dom7Slots, probeRef);
        await rerender(root, makeDom7Latest(), dom7Slots, probeRef);
        expect(probeRef.result?.lockedChord?.type).toBe(ChordType.DominantSeventh);

        // Major 4-voice layout: root, maj3, P5, octave-doubled root.
        // Voice count stays at 4 (same dom7Slots) so the validity-guard
        // does not fire — the lock can only transition via hysteresis, not
        // via a voice-count drop. The doubled root contributes 0¢ deviation
        // to any hypothesis (root is always a valid target), so it does not
        // bias the classifier; major wins because it fits 3 voices perfectly
        // and dom7 has no voice near the 7:4 slot.
        const makeMajor4VoiceLatest = (): Record<string, FormantFrame> => ({
            bass: frame(C4),
            bari: frame(C4 * 5 / 4),
            lead: frame(C4 * 3 / 2),
            tnr: frame(C4 * 2),   // octave-doubled root
        });

        // Frame 3: major candidate starts (counter=1). Lock still dom7.
        await rerender(root, makeMajor4VoiceLatest(), dom7Slots, probeRef);
        expect(probeRef.result?.lockedChord?.type).toBe(ChordType.DominantSeventh);

        // Frame 4: major counter reaches 2, promotes to locked.
        await rerender(root, makeMajor4VoiceLatest(), dom7Slots, probeRef);
        expect(probeRef.result?.lockedChord?.type).toBe(ChordType.Major);

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('exposes per-voice residuals for the locked chord', async () => {
        const probeRef: ProbeRef = {result: null};
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        await mountHarness(container, root, makeDom7Latest(), dom7Slots, probeRef);
        await rerender(root, makeDom7Latest(), dom7Slots, probeRef);

        const residuals = probeRef.result?.residualsPerVoice;
        expect(residuals).toBeDefined();
        // Root residual is 0 by definition.
        expect(residuals?.get('bass')).toBe(0);
        // Non-root residuals are present and close to zero for pure JI input.
        for (const channelId of ['bari', 'lead', 'tnr']) {
            const r = residuals?.get(channelId);
            expect(r).toBeDefined();
            expect(Math.abs(r!)).toBeLessThan(1);
        }

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('returns no-chord-locked for fewer than 3 active voices', async () => {
        const probeRef: ProbeRef = {result: null};
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        const twoVoiceSlots: SlotDescriptor[] = [
            {channelId: 'a', slotIndex: 0},
            {channelId: 'b', slotIndex: 1},
        ];

        // Run two frames to rule out hysteresis as the reason for null.
        await mountHarness(container, root, {a: frame(440), b: frame(550)}, twoVoiceSlots, probeRef);
        await rerender(root, {a: frame(440), b: frame(550)}, twoVoiceSlots, probeRef);

        expect(probeRef.result?.lockedChord).toBeNull();

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    it('excludes voices with confidence below the display gate', async () => {
        const probeRef: ProbeRef = {result: null};
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);

        // The fourth voice has low confidence — should be excluded.
        const makeLowConf = (): Record<string, FormantFrame> => ({
            bass: frame(C4),
            bari: frame(C4 * 5 / 4),
            lead: frame(C4 * 3 / 2),
            tnr: frame(C4 * 7 / 4, 0.1),  // below MIN_DISPLAY_CONFIDENCE=0.6
        });

        await mountHarness(container, root, makeLowConf(), dom7Slots, probeRef);
        await rerender(root, makeLowConf(), dom7Slots, probeRef);

        // With tnr excluded, 3 voices remain — can lock as Major or similar
        // triad, but never as DominantSeventh (minArity=4).
        expect(probeRef.result?.lockedChord?.type).not.toBe(ChordType.DominantSeventh);

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });
});
