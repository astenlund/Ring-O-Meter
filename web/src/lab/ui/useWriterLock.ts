// web/src/lab/ui/useWriterLock.ts
// Single-writer guard for the lab tab. Web Locks is preferred (auto-releases on tab
// close/crash, so no stale-lock recovery). Without it, a localStorage heartbeat
// provides the same guarantee: the holder rewrites a timestamp every HEARTBEAT_MS;
// a key older than TTL_MS (several missed beats) is stale and reclaimable. With
// neither, the lab warns-and-allows (state 'unguarded') because in a solo-dev tool a
// hard lockout would cost more than it protects (spec section "### Store admin...").

import {useEffect, useState} from 'react';

const LOCK_NAME = 'ring-o-meter-lab-writer';
const HEARTBEAT_KEY = 'ring-o-meter-lab-writer-heartbeat';
const HEARTBEAT_MS = 1000;
const TTL_MS = 5000;

export type WriterLockState = {state: 'held' | 'blocked' | 'unguarded' | 'acquiring'};

interface LockApi {
    request(name: string, options: {mode?: string; ifAvailable?: boolean}, callback: (lock: unknown) => Promise<void>): Promise<void>;
}

function getLockApi(): LockApi | null {
    const nav = globalThis.navigator as unknown as {locks?: LockApi} | undefined;

    return nav?.locks ?? null;
}

function storageAvailable(): boolean {
    try {
        const probe = '__lab_probe__';
        localStorage.setItem(probe, '1');
        localStorage.removeItem(probe);

        return true;
    } catch {
        return false;
    }
}

export function useWriterLock(): WriterLockState {
    const [state, setState] = useState<WriterLockState['state']>('acquiring');

    useEffect(() => {
        const locks = getLockApi();
        if (locks) {
            let release: (() => void) | null = null;
            // ifAvailable: the callback gets null if the lock is already held elsewhere.
            void locks.request(LOCK_NAME, {ifAvailable: true}, (lock) =>
                new Promise<void>((resolve) => {
                    if (lock === null) {
                        setState('blocked');
                        resolve();

                        return;
                    }
                    setState('held');
                    release = resolve; // hold the lock until unmount
                }),
            );

            return () => {
                release?.();
            };
        }

        if (!storageAvailable()) {
            setState('unguarded');

            return;
        }

        // localStorage heartbeat fallback.
        const now = Date.now();
        const existing = Number(localStorage.getItem(HEARTBEAT_KEY) ?? '0');
        if (existing && now - existing < TTL_MS) {
            setState('blocked');

            return;
        }
        localStorage.setItem(HEARTBEAT_KEY, String(now));
        setState('held');
        const timer = setInterval(() => {
            localStorage.setItem(HEARTBEAT_KEY, String(Date.now()));
        }, HEARTBEAT_MS);

        return () => {
            clearInterval(timer);
            const mine = Number(localStorage.getItem(HEARTBEAT_KEY) ?? '0');
            // Only clear if it still looks like ours (within one TTL of our last beat).
            if (Date.now() - mine < TTL_MS) {
                localStorage.removeItem(HEARTBEAT_KEY);
            }
        };
    }, []);

    return {state};
}
