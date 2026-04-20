import {shouldDisplayPitch} from './displayGate';
import {formatNoteWithCents} from './formatPitch';

export interface NoteReadoutProps {
    deviceLabel: string;
    fundamentalHz: number;
    confidence: number;
}

export function NoteReadout({deviceLabel, fundamentalHz, confidence}: NoteReadoutProps) {
    const text = formatNoteWithCents(fundamentalHz);
    const dim = !shouldDisplayPitch(fundamentalHz, confidence);

    return (
        <div style={{
            padding: 12,
            border: '1px solid #444',
            borderRadius: 6,
            opacity: dim ? 0.4 : 1,
            minWidth: 160,
        }}>
            <div style={{fontSize: 12, opacity: 0.7}}>{deviceLabel}</div>
            <div style={{fontSize: 28, fontFamily: 'monospace'}}>{text}</div>
        </div>
    );
}
