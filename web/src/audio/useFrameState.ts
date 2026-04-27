import {useCallback, useEffect, useRef, useState} from 'react';
import type {FrameRingReader, UiFrame} from './frameRing';

// Polls each registered reader on an rAF-paced schedule (capped at
// ~15 Hz) and swaps a 2-buffer pool of `Record<string, UiFrame>` into
// React state. Each buffer owns its own UiFrame instances per
// channelId, so the buffer React is currently rendering with is never
// mutated; mutations land in scratch only, then the active index
// flips and React sees a fresh reference. Stalled channels retain
// their prior UiFrame values via field-by-field carry-over from
// active to scratch, so a momentarily-silent voice's NoteReadout
// keeps rendering its last-known pitch rather than blanking. Entries
// are removed only on explicit unregisterReader.
//
// Concurrent-rendering: the 2-buffer design assumes at most one
// render in flight per state value at any moment. App.tsx renders
// <NoteReadout> directly with no Suspense boundary above it, and no
// startTransition is used anywhere. If either changes, escalate to a
// triple-buffer pool or useSyncExternalStore + Object.freeze
// snapshots; mutating the active buffer mid-render would tear the
// readout's scalar reads.
//
// heuristic: ui-flush-rate
const MIN_FLUSH_INTERVAL_MS = 66;

// Copies UiFrame fields in place from src into dst. Centralised so
// that adding a field to UiFrame requires only one update here
// rather than at every carry-over call site.
function copyFrame(dst: UiFrame, src: UiFrame): void {
    dst.fundamentalHz = src.fundamentalHz;
    dst.confidence = src.confidence;
}

// Returns [active, scratch] for the given buffer-pool index.
// Active is the buffer React currently holds; scratch is the one
// to write into before flipping. The returned pair is a tiny
// 2-element array allocated on each call — at ≤15 Hz this is
// imperceptible and keeps callers free of repeated ternary pairs.
function getBuffers(
    index: 0 | 1,
    bufA: Record<string, UiFrame>,
    bufB: Record<string, UiFrame>,
): [Record<string, UiFrame>, Record<string, UiFrame>] {
    return index === 0 ? [bufA, bufB] : [bufB, bufA];
}

// Flips the 0|1 pool index.
function flipIndex(index: 0 | 1): 0 | 1 {
    return index === 0 ? 1 : 0;
}

interface ReaderEntry {
    reader: FrameRingReader;
    lastSeenPublished: number;
}

export interface FrameStateControl {
    /**
     * Latest frame snapshot per registered channelId. Keys are
     * eagerly present with `{fundamentalHz: 0, confidence: 0}`
     * immediately after `registerReader` — they do not wait for the
     * first flush. Consumers should use optional-chaining or `?? 0`
     * rather than membership checks.
     */
    latest: Record<string, UiFrame>;
    registerReader(channelId: string, reader: FrameRingReader): void;
    unregisterReader(channelId: string): void;
}

export function useFrameState(): FrameStateControl {
    const bufARef = useRef<Record<string, UiFrame>>({});
    const bufBRef = useRef<Record<string, UiFrame>>({});
    // Mutated only from `flush` (rAF callback) and `unregisterReader`
    // (event handler); both run on the main thread without
    // preemption, so no Atomics guard is needed. Hardening this with
    // synchronisation would actually break the read/write ordering
    // the buffer pool relies on.
    const activeIndexRef = useRef<0 | 1>(0);
    const [latest, setLatest] = useState<Record<string, UiFrame>>(bufARef.current);
    const readersRef = useRef<Map<string, ReaderEntry>>(new Map());
    const rafIdRef = useRef(0);
    const lastFlushMsRef = useRef(0);

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

        const [active, scratch] = getBuffers(activeIndexRef.current, bufARef.current, bufBRef.current);

        for (const [channelId, entry] of readersRef.current) {
            const pub = entry.reader.published();
            const target = scratch[channelId];
            if (pub === entry.lastSeenPublished) {
                // Carry over: stalled channel keeps its prior values.
                copyFrame(target, active[channelId]);
                continue;
            }
            if (!entry.reader.readLatest(target)) {
                // No frame published yet for this advanced channel
                // (rare past first publish): carry over from active.
                copyFrame(target, active[channelId]);
            }
            entry.lastSeenPublished = pub;
        }

        activeIndexRef.current = flipIndex(activeIndexRef.current);
        setLatest(scratch);

        rafIdRef.current = requestAnimationFrame(flush);
    }, []);

    const armIfIdle = useCallback(() => {
        if (rafIdRef.current === 0) {
            rafIdRef.current = requestAnimationFrame(flush);
        }
    }, [flush]);

    const registerReader = useCallback((channelId: string, reader: FrameRingReader) => {
        readersRef.current.set(channelId, {reader, lastSeenPublished: 0});
        bufARef.current[channelId] = {fundamentalHz: 0, confidence: 0};
        bufBRef.current[channelId] = {fundamentalHz: 0, confidence: 0};
        armIfIdle();
    }, [armIfIdle]);

    const unregisterReader = useCallback((channelId: string) => {
        readersRef.current.delete(channelId);

        const [active, scratch] = getBuffers(activeIndexRef.current, bufARef.current, bufBRef.current);

        // Bring scratch forward on every still-registered channel
        // before flipping; the previously-scratch buffer is one flush
        // behind, and without this copy every survivor's NoteReadout
        // would roll back ~66 ms for a single render tick.
        // Iterates post-delete readersRef so the removed channel
        // is naturally skipped.
        for (const [survivorId] of readersRef.current) {
            copyFrame(scratch[survivorId], active[survivorId]);
        }

        delete bufARef.current[channelId];
        delete bufBRef.current[channelId];

        // Eager pre-seeding in registerReader makes the key always
        // present at unregister time, so the flip + setLatest are
        // unconditional - any guard like
        // `if (mirror[channelId] !== undefined)` would skip the flip
        // in a register-then-unregister-before-first-publish path
        // and leave activeIndexRef pointing at a buffer that still
        // holds the deleted key on the next flush.
        activeIndexRef.current = flipIndex(activeIndexRef.current);
        setLatest(scratch);

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
