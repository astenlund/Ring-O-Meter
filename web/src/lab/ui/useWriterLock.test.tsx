// web/src/lab/ui/useWriterLock.test.tsx
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {act} from 'react';
import {useWriterLock, type WriterLockState} from './useWriterLock';

let container: HTMLDivElement;
let root: Root;
const probe: {current: WriterLockState | null} = {current: null};

function Probe() {
    probe.current = useWriterLock();

    return null;
}

function mount() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // act flushes passive effects (useEffect) in addition to the render.
    act(() => { root.render(<Probe />); });
}

describe('useWriterLock', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        act(() => { root.unmount(); });
        container.remove();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('reports unguarded when neither Web Locks nor localStorage is available', () => {
        // Arrange: no navigator.locks, localStorage throws.
        vi.stubGlobal('navigator', {});
        const throwingStorage = {getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined};
        vi.stubGlobal('localStorage', throwingStorage);

        // Act
        mount();

        // Assert
        expect(probe.current!.state).toBe('unguarded');
    });

    it('uses the localStorage heartbeat fallback when Web Locks is absent', () => {
        // Arrange: no navigator.locks, real localStorage (jsdom provides it).
        vi.stubGlobal('navigator', {});

        // Act
        mount();

        // Assert: holds the lock (no prior live heartbeat in storage).
        expect(['held', 'acquiring']).toContain(probe.current!.state);
    });
});
