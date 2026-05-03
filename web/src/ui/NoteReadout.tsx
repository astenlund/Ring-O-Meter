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
// cached text is what the user sees, dimmed via opacity, when the
// gate is currently failing. Targets staccato GPU-process raster
// spikes that cluster on the audio onset/offset cycle: the text-width
// change at every transition forced layer re-rasterization at 6.6
// transitions/s on a fixture with 200 ms tone + 100 ms silence.
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
            opacity: dim ? 0.4 : 1,
            minWidth: 160,
        }}>
            <div style={{fontSize: 12, opacity: 0.7}}>{deviceLabel}</div>
            <div style={{fontSize: 28, fontFamily: 'monospace'}}>{lastValidTextRef.current}</div>
        </div>
    );
}
