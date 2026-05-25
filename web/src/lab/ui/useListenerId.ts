// web/src/lab/ui/useListenerId.ts
// Owns the lab's listener identity: minted once into localStorage and reused across
// reloads (MVP is single-listener). When localStorage is unavailable the id is
// ephemeral (per-session) and calibration data will not accumulate across reloads.

import {useCallback, useState} from 'react';

const LISTENER_ID_KEY = 'ring-o-meter-lab-listener-id';

export interface ListenerIdControl {
    listenerId: string;
    ephemeral: boolean;
    reset: () => void;
}

function readStored(): string | null {
    try {
        return localStorage.getItem(LISTENER_ID_KEY);
    } catch {
        // localStorage unavailable (private mode / disabled).

        return null;
    }
}

function writeStored(id: string): boolean {
    try {
        localStorage.setItem(LISTENER_ID_KEY, id);

        return true;
    } catch {
        // Write blocked; caller treats the id as ephemeral.

        return false;
    }
}

export function useListenerId(): ListenerIdControl {
    const [control, setControl] = useState(() => {
        const existing = readStored();
        if (existing !== null) {
            return {listenerId: existing, ephemeral: false};
        }
        const minted = crypto.randomUUID();
        const persisted = writeStored(minted);

        return {listenerId: minted, ephemeral: !persisted};
    });

    const reset = useCallback(() => {
        const minted = crypto.randomUUID();
        const persisted = writeStored(minted);
        setControl({listenerId: minted, ephemeral: !persisted});
    }, []);

    return {listenerId: control.listenerId, ephemeral: control.ephemeral, reset};
}
