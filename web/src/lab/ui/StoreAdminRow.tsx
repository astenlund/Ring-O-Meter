// web/src/lab/ui/StoreAdminRow.tsx
// Store-admin row: Export-to-JSON and Clear-all (behind a two-step confirm). The
// parent serializes both under the writer lock, mutually exclusive with trial-submit
// (spec "### Store admin..."). This component owns the confirm gate + busy disable.

import {type CSSProperties, useState} from 'react';

export interface StoreAdminRowProps {
    onExport: () => void;
    onClearAll: () => void;
    busy: boolean;
}

const rowStyle: CSSProperties = {display: 'flex', gap: 12, alignItems: 'center', padding: 12, background: '#1c1c1c', borderRadius: 8, marginBottom: 16};

export function StoreAdminRow(props: StoreAdminRowProps) {
    const [confirming, setConfirming] = useState(false);

    return (
        <div style={rowStyle} data-testid="store-admin">
            <button type="button" data-testid="export" disabled={props.busy} onClick={props.onExport}>Export JSON</button>
            {!confirming ? (
                <button type="button" data-testid="clear-all" disabled={props.busy} onClick={() => setConfirming(true)}>Clear all</button>
            ) : (
                <>
                    <span style={{color: 'crimson'}}>Delete all trials?</span>
                    <button type="button" data-testid="clear-all-confirm" disabled={props.busy} onClick={() => { setConfirming(false); props.onClearAll(); }}>Confirm</button>
                    <button type="button" data-testid="clear-all-cancel" onClick={() => setConfirming(false)}>Cancel</button>
                </>
            )}
        </div>
    );
}
