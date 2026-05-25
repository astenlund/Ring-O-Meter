// web/src/lab/ui/StatusStrip.tsx
// Top status strip: the three pieces of ambient state the operator needs at a
// glance (spec "### Route and shell"). Presentational only.

import type {CSSProperties} from 'react';
import type {WriterLockState} from './useWriterLock';

export interface StatusStripProps {
    listenerId: string;
    listenerEphemeral: boolean;
    lock: WriterLockState['state'];
    storage: 'ok' | 'unavailable';
    onResetListener?: () => void;
    resetDisabled?: boolean;
}

const stripStyle: CSSProperties = {
    display: 'flex',
    gap: 24,
    alignItems: 'center',
    padding: '8px 12px',
    background: '#222',
    borderRadius: 8,
    marginBottom: 16,
    fontSize: '0.85em',
};

export function StatusStrip(props: StatusStripProps) {
    const lockLabel: Record<WriterLockState['state'], string> = {
        held: 'writer: this tab',
        blocked: 'writer: another tab',
        unguarded: 'writer: unguarded',
        acquiring: 'writer: acquiring...',
    };

    return (
        <div style={stripStyle} data-testid="status-strip">
            <span data-testid="listener-id">listener: {props.listenerId.slice(0, 8)}{props.listenerEphemeral ? ' (ephemeral)' : ''}</span>
            <span data-testid="lock-state">{lockLabel[props.lock]}</span>
            <span data-testid="storage-state">storage: {props.storage}</span>
            {props.onResetListener && (
                <button type="button" onClick={props.onResetListener} disabled={props.resetDisabled}>
                    Reset listener
                </button>
            )}
        </div>
    );
}
