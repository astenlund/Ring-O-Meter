import {formatNoteWithCents} from './formatPitch';

export interface NoteReadoutProps {
    voiceLabel: string;
    fundamentalHz: number;
    confidence: number;
}

export function NoteReadout({voiceLabel, fundamentalHz, confidence}: NoteReadoutProps) {
    const text = formatNoteWithCents(fundamentalHz);
    const dim = confidence < 0.5;

    return (
        <div style={{
            padding: 12,
            border: '1px solid #444',
            borderRadius: 6,
            opacity: dim ? 0.4 : 1,
            minWidth: 160,
        }}>
            <div style={{fontSize: 12, opacity: 0.7}}>{voiceLabel}</div>
            <div style={{fontSize: 28, fontFamily: 'monospace'}}>{text}</div>
        </div>
    );
}
