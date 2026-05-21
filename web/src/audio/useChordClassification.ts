import {useEffect, useMemo, useRef, useState} from 'react';
import type {FormantFrame} from './frameRing';
import {classifyChord, type ClassifierResult, type VoiceObservation} from './chordClassifier';
import {ChordHysteresis} from './chordHysteresis';
import {shouldDisplayPitch} from '../ui/displayGate';

export interface ChordClassificationResult {
    /** Latest hysteresis-stabilised chord lock; null = no chord locked. */
    readonly lockedChord: ClassifierResult['lockedChord'];
    /** Per-voice residuals from the locked frame. */
    readonly residualsPerVoice: ClassifierResult['residualsPerVoice'];
}

// Minimal slot shape the hook needs: channelId to look up in `latest`,
// slotIndex for VoiceObservation (passed through to the classifier for
// future slot-ordered residual rendering).
export interface SlotDescriptor {
    readonly channelId: string;
    readonly slotIndex: number;
}

const EMPTY_RESULT: ChordClassificationResult = {
    lockedChord: null,
    residualsPerVoice: new Map(),
};

/**
 * Bridges `useFrameState`'s coalesce output to the chord classifier +
 * hysteresis state machine. Called each render cycle when `latest`
 * reference changes (i.e., at the ~15 Hz coalesce rate).
 *
 * Accepts the `latest` map from `useFrameState` and the current slot
 * descriptors rather than calling `useFrameState` internally, keeping the
 * hook composable and directly testable with synthetic frame data.
 *
 * Returns `{lockedChord, residualsPerVoice}` where `lockedChord` is a
 * React state value (triggers re-renders on chord-lock changes only) and
 * `residualsPerVoice` rides along on the same state object so consumers
 * always see a consistent pair.
 *
 * `ChordHysteresis` is per-hook-instance (not module-scoped) so each
 * mounted consumer has independent debounce state.
 */
export function useChordClassification(
    latest: Record<string, FormantFrame>,
    slots: ReadonlyArray<SlotDescriptor>,
): ChordClassificationResult {
    // One hysteresis instance per hook lifetime.
    const hysteresisRef = useRef<ChordHysteresis | null>(null);
    if (hysteresisRef.current === null) {
        hysteresisRef.current = new ChordHysteresis();
    }

    const [result, setResult] = useState<ChordClassificationResult>(EMPTY_RESULT);

    // Build the observations array from the current frame state.
    // Re-runs whenever `latest` or `slots` references change, which is
    // exactly the coalesce rate for `latest` and the lifecycle rate for
    // `slots`. useMemo avoids recreating the array on unrelated renders.
    const observations = useMemo<VoiceObservation[]>(() => {
        return slots.map((slot) => {
            const frame = latest[slot.channelId];
            const f0Hz = frame?.fundamentalHz ?? 0;
            const confidence = frame?.confidence ?? 0;
            const gateOpen = shouldDisplayPitch(f0Hz, confidence);

            return {
                channelId: slot.channelId,
                f0Hz,
                slotIndex: slot.slotIndex,
                gateOpen,
            };
        });
    }, [latest, slots]);

    useEffect(() => {
        const hysteresis = hysteresisRef.current!;

        const classifierResult = classifyChord(observations);
        const activeCount = observations.filter((o) => o.gateOpen && o.f0Hz > 0).length;
        const afterHysteresis = hysteresis.step(classifierResult, activeCount);

        setResult((prev) => {
            // Avoid re-render if the chord-lock identity hasn't changed.
            // Residuals update continuously while the chord is stable;
            // consumers that need per-frame residuals (e.g., bar renderer)
            // should wire directly to PlotController rather than reading
            // this state.
            const prevChord = prev.lockedChord;
            const nextChord = afterHysteresis.lockedChord;
            const chordChanged =
                prevChord?.type !== nextChord?.type
                || prevChord?.rootChannelId !== nextChord?.rootChannelId;

            if (!chordChanged && prevChord === null && nextChord === null) {
                return prev;
            }
            if (!chordChanged && prevChord !== null && nextChord !== null) {
                // Chord identity is stable; still update residuals so React
                // renders reflect the latest tuning positions.
                return {
                    lockedChord: nextChord,
                    residualsPerVoice: afterHysteresis.residualsPerVoice,
                };
            }

            return {
                lockedChord: nextChord,
                residualsPerVoice: afterHysteresis.residualsPerVoice,
            };
        });
    }, [observations]);

    return result;
}
