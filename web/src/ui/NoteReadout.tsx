import {useRef} from 'react';

import {shouldDisplayPitch} from './displayGate';
import {formatNoteWithCents} from './formatPitch';

const PEAK_HOLD_MS = 1000;

// Peak-hold tracker for diagnostic min/max display. Standard
// audio-meter pattern: capture an extreme, hold for `holdMs`, then
// auto-reset so the next extreme of any size can be captured. Returns
// the held value when an active hold exists AND it differs from the
// current value (so the held line only appears when there's something
// meaningfully different from the live reading); returns null
// otherwise. State persists across renders via useRef; values reset
// on holdMs expiry without requiring an explicit timer (the polling
// re-render at ~15 Hz from useFrameState drives the elapsed check).
function usePeakHold(current: number, mode: 'min' | 'max', holdMs: number): number | null {
    const ref = useRef<{value: number; setAt: number}>({value: 0, setAt: 0});
    const now = performance.now();

    if (current > 0) {
        const elapsed = ref.current.setAt > 0 ? now - ref.current.setAt : Infinity;

        if (elapsed > holdMs) {
            // Reset: capture current as new tracking baseline.
            ref.current.value = current;
            ref.current.setAt = now;
        } else if (mode === 'min' ? current < ref.current.value : current > ref.current.value) {
            // New extreme within hold window.
            ref.current.value = current;
            ref.current.setAt = now;
        }
    }

    if (ref.current.setAt > 0
        && now - ref.current.setAt < holdMs
        && ref.current.value !== current) {
        return ref.current.value;
    }

    return null;
}

export interface NoteReadoutProps {
    deviceLabel: string;
    fundamentalHz: number;
    confidence: number;
    // Optional formant readout. When both are supplied, a small "F1=N
    // F2=N" line renders below the pitch digits. Used for manual
    // triage during the vowel-graph slice's algorithm-comparison phase
    // - lets the user verify polygon-position observations against
    // raw Hz numbers (especially useful for diagnosing spurious-root
    // blips where F2 jumps to F3-territory frequencies). Pass undefined
    // (or omit) to suppress the formant line.
    f1Hz?: number;
    f2Hz?: number;
}

// Cache the last valid formatted text so audio-transition gaps don't
// force a text-width change (e.g., "A3 +0c" -> "--" and back). The
// cached text is what the user sees when the gate is currently
// failing, with a dimmed text color signalling "currently invalid".
//
// Two paint-cost mitigations sit on the dim signal:
//   1. The dim is reflected via `color` on the small cents text
//      element only, NOT via `opacity` on the whole container. With
//      4 sibling readouts in the production layout, container
//      opacity flips at audio offsets compounded across siblings
//      and produced a measurable raster cluster (140+ GPU > 10 ms
//      frames in 60 s, peaking at 220-260 ms phase of the 300 ms
//      staccato cycle). Color-on-text shrinks the affected paint
//      region from the whole readout to just the digits and drops
//      the cluster to noise floor (< 10 frames in 60 s).
//   2. The cached text means the *content* of the dim element does
//      not change during gate-fail, so the only mutation is the
//      `color` attribute - much cheaper than a text-width swap.
// Tested 2026-05-03. Permanent `will-change: opacity` was tested as
// a sibling mitigation and rejected (introduced 100 ms compositor
// freezes when applied to 4 readouts; see
// .claude/patterns/frame-rate-dom-mutation-discipline.md Cautionary
// tales).
const PLACEHOLDER_TEXT = '--';

function formatFormantLine(label: string, current: number, min: number | null, max: number | null): string {
    const currentText = current > 0 ? Math.round(current).toString() : PLACEHOLDER_TEXT;
    const parts = [`${label}: ${currentText}`];
    if (min !== null) {
        parts.push(`min ${Math.round(min)}`);
    }
    if (max !== null) {
        parts.push(`max ${Math.round(max)}`);
    }

    return parts.length > 1 ? `${parts[0]}  (${parts.slice(1).join(', ')})` : parts[0];
}

export function NoteReadout({deviceLabel, fundamentalHz, confidence, f1Hz, f2Hz}: NoteReadoutProps) {
    const dim = !shouldDisplayPitch(fundamentalHz, confidence);
    const lastValidTextRef = useRef(PLACEHOLDER_TEXT);
    if (!dim) {
        lastValidTextRef.current = formatNoteWithCents(fundamentalHz);
    }

    // Peak-hold trackers for each formant. Hooks always run unconditionally
    // (React's rules); when f1Hz/f2Hz props are undefined we pass 0, which
    // skips updates inside usePeakHold via the `current > 0` guard.
    const f1Min = usePeakHold(f1Hz ?? 0, 'min', PEAK_HOLD_MS);
    const f1Max = usePeakHold(f1Hz ?? 0, 'max', PEAK_HOLD_MS);
    const f2Min = usePeakHold(f2Hz ?? 0, 'min', PEAK_HOLD_MS);
    const f2Max = usePeakHold(f2Hz ?? 0, 'max', PEAK_HOLD_MS);
    const showFormants = f1Hz !== undefined && f2Hz !== undefined;

    return (
        <div style={{
            padding: 12,
            border: '1px solid #444',
            borderRadius: 6,
            minWidth: 160,
        }}>
            <div style={{fontSize: 12, opacity: 0.7}}>{deviceLabel}</div>
            <div style={{
                fontSize: 28,
                fontFamily: 'monospace',
                color: dim ? '#888' : '#eee',
            }}>{lastValidTextRef.current}</div>
            {showFormants && (
                <>
                    <div style={{
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: '#888',
                        marginTop: 4,
                    }}>
                        {formatFormantLine('F1', f1Hz ?? 0, f1Min, f1Max)}
                    </div>
                    <div style={{
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: '#888',
                        marginTop: 2,
                    }}>
                        {formatFormantLine('F2', f2Hz ?? 0, f2Min, f2Max)}
                    </div>
                </>
            )}
        </div>
    );
}
