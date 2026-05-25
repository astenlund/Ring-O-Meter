// web/src/lab/ui/useListenerId.test.tsx
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {useListenerId, type ListenerIdControl} from './useListenerId';

const KEY = 'ring-o-meter-lab-listener-id';

let container: HTMLDivElement;
let root: Root;
const probe: {current: ListenerIdControl | null} = {current: null};

function Probe() {
    probe.current = useListenerId();

    return null;
}

describe('useListenerId', () => {
    beforeEach(() => {
        localStorage.clear();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
    });

    it('mints and persists a stable id across mounts', () => {
        // Arrange / Act
        flushSync(() => root.render(<Probe />));
        const first = probe.current!.listenerId;

        // Assert: persisted to localStorage and stable on remount.
        expect(localStorage.getItem(KEY)).toBe(first);
        flushSync(() => root.unmount());
        root = createRoot(container);
        flushSync(() => root.render(<Probe />));
        expect(probe.current!.listenerId).toBe(first);
        expect(probe.current!.ephemeral).toBe(false);
    });

    it('reset mints a new id', () => {
        // Arrange
        flushSync(() => root.render(<Probe />));
        const first = probe.current!.listenerId;

        // Act
        flushSync(() => probe.current!.reset());

        // Assert
        expect(probe.current!.listenerId).not.toBe(first);
    });
});
