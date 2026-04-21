import {useCallback, useEffect, useRef, useState} from 'react';
import type {AnalysisFrame} from '../wire/frames';

// Coalesces per-frame React state updates into rAF-paced flushes capped
// at ~15 Hz. The plot worker receives every frame via PlotController
// separately; only the React-visible `latest` map throttles here.
// NoteReadout at ~15 Hz is imperceptible to a reader versus ~94 Hz, and
// the difference in VDOM churn and main-thread allocation pressure is
// ~6x. Slice 1 wraps this hook with a SignalR receive path on the
// DisplayClient: applyFrame re-enters from the hub message handler with
// the same shape.
//
// heuristic: ui-flush-rate
const MIN_FLUSH_INTERVAL_MS = 66;

export interface FrameState {
    latest: Record<string, AnalysisFrame>;
    applyFrame(frame: AnalysisFrame): void;
}

export function useFrameState(): FrameState {
    const [latest, setLatest] = useState<Record<string, AnalysisFrame>>({});
    const pendingRef = useRef<Record<string, AnalysisFrame>>({});
    const rafIdRef = useRef(0);
    const lastFlushMsRef = useRef(0);

    // Declared first so applyFrame can reference it. flush re-arms itself
    // via rAF when the cap is not yet reached, so a burst of applyFrame
    // calls produces at most one setLatest per ~66 ms interval.
    const flush = useCallback((nowMs: number) => {
        rafIdRef.current = 0;
        if (nowMs - lastFlushMsRef.current < MIN_FLUSH_INTERVAL_MS) {
            rafIdRef.current = requestAnimationFrame(flush);

            return;
        }
        const merged = pendingRef.current;
        pendingRef.current = {};
        lastFlushMsRef.current = nowMs;
        setLatest((prev) => ({...prev, ...merged}));
    }, []);

    const applyFrame = useCallback((frame: AnalysisFrame) => {
        pendingRef.current[frame.channelId] = frame;
        if (rafIdRef.current === 0) {
            rafIdRef.current = requestAnimationFrame(flush);
        }
    }, [flush]);

    useEffect(() => {
        return () => {
            if (rafIdRef.current !== 0) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = 0;
            }
        };
    }, []);

    return {latest, applyFrame};
}
