import {useRef} from 'react';

import {shouldDisplayPitch} from './displayGate';
import {formatNoteWithCents} from './formatPitch';

export interface NoteReadoutProps {
    deviceLabel: string;
    fundamentalHz: number;
    confidence: number;
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

export function NoteReadout({deviceLabel, fundamentalHz, confidence}: NoteReadoutProps) {
    const dim = !shouldDisplayPitch(fundamentalHz, confidence);
    const lastValidTextRef = useRef(PLACEHOLDER_TEXT);
    if (!dim) {
        lastValidTextRef.current = formatNoteWithCents(fundamentalHz);
    }

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
        </div>
    );
}
