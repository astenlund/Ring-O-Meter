import {useRef} from 'react';

import {shouldDisplayPitch} from './displayGate';
import {formatNoteWithCents} from './formatPitch';

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

export function NoteReadout({deviceLabel, fundamentalHz, confidence, f1Hz, f2Hz}: NoteReadoutProps) {
    const dim = !shouldDisplayPitch(fundamentalHz, confidence);
    const lastValidTextRef = useRef(PLACEHOLDER_TEXT);
    if (!dim) {
        lastValidTextRef.current = formatNoteWithCents(fundamentalHz);
    }

    const showFormants = f1Hz !== undefined && f2Hz !== undefined;
    const f1Text = f1Hz && f1Hz > 0 ? Math.round(f1Hz).toString() : PLACEHOLDER_TEXT;
    const f2Text = f2Hz && f2Hz > 0 ? Math.round(f2Hz).toString() : PLACEHOLDER_TEXT;

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
                <div style={{
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: '#888',
                    marginTop: 4,
                }}>
                    F1={f1Text} F2={f2Text}
                </div>
            )}
        </div>
    );
}
