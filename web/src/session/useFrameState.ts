import {useCallback, useEffect, useRef, useState} from 'react';
import type {FrameRingReader, UiFrame} from '../audio/frameRing';

// Polls each registered reader on an rAF-paced schedule (capped at
// ~15 Hz) and builds a new `latest` map only when at least one
// reader advanced since the last flush. Stalled channels retain
// their prior UiFrame entry via copy-then-overwrite, so a
// momentarily-silent voice's NoteReadout keeps rendering its
// last-known pitch rather than blanking. Entries are removed only
// on explicit unregisterReader.
//
// heuristic: ui-flush-rate
const MIN_FLUSH_INTERVAL_MS = 66;

interface ReaderEntry {
    reader: FrameRingReader;
    lastSeenPublished: number;
}

export interface FrameStateControl {
    latest: Record<string, UiFrame>;
    registerReader(channelId: string, reader: FrameRingReader): void;
    unregisterReader(channelId: string): void;
}

export function useFrameState(): FrameStateControl {
    const [latest, setLatest] = useState<Record<string, UiFrame>>({});
    const readersRef = useRef<Map<string, ReaderEntry>>(new Map());
    const rafIdRef = useRef(0);
    const lastFlushMsRef = useRef(0);
    // Mirror of `latest` used by flush to avoid reading React state
    // inside the rAF callback. Kept in sync via setLatest's updater.
    const latestMirrorRef = useRef<Record<string, UiFrame>>({});

    const flush = useCallback((nowMs: number) => {
        rafIdRef.current = 0;
        if (readersRef.current.size === 0) {
            // No readers - do not re-arm.
            return;
        }
        if (nowMs - lastFlushMsRef.current < MIN_FLUSH_INTERVAL_MS) {
            rafIdRef.current = requestAnimationFrame(flush);

            return;
        }

        let anyAdvanced = false;
        for (const entry of readersRef.current.values()) {
            const pub = entry.reader.published();
            if (pub !== entry.lastSeenPublished) {
                anyAdvanced = true;
                break;
            }
        }

        if (!anyAdvanced) {
            // No advance: re-arm but skip setLatest.
            rafIdRef.current = requestAnimationFrame(flush);

            return;
        }

        lastFlushMsRef.current = nowMs;

        // Copy-then-overwrite: start from prior map (React identity
        // requires a new object), overwrite only the channels whose
        // readers advanced since the last seen.
        const next: Record<string, UiFrame> = {...latestMirrorRef.current};
        for (const [channelId, entry] of readersRef.current) {
            const pub = entry.reader.published();
            if (pub === entry.lastSeenPublished) {
                continue;
            }
            const ui = entry.reader.readLatest();
            if (ui) {
                next[channelId] = ui;
            }
            entry.lastSeenPublished = pub;
        }
        latestMirrorRef.current = next;
        setLatest(next);

        rafIdRef.current = requestAnimationFrame(flush);
    }, []);

    const armIfIdle = useCallback(() => {
        if (rafIdRef.current === 0) {
            rafIdRef.current = requestAnimationFrame(flush);
        }
    }, [flush]);

    const registerReader = useCallback((channelId: string, reader: FrameRingReader) => {
        readersRef.current.set(channelId, {reader, lastSeenPublished: 0});
        armIfIdle();
    }, [armIfIdle]);

    const unregisterReader = useCallback((channelId: string) => {
        readersRef.current.delete(channelId);
        // Remove the entry from both the mirror and React state.
        if (latestMirrorRef.current[channelId] !== undefined) {
            const next = {...latestMirrorRef.current};
            delete next[channelId];
            latestMirrorRef.current = next;
            setLatest(next);
        }
        if (readersRef.current.size === 0 && rafIdRef.current !== 0) {
            cancelAnimationFrame(rafIdRef.current);
            rafIdRef.current = 0;
        }
    }, []);

    useEffect(() => {
        return () => {
            if (rafIdRef.current !== 0) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = 0;
            }
        };
    }, []);

    return {latest, registerReader, unregisterReader};
}
