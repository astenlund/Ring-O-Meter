import {describe, test, expect, vi} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {act, StrictMode, useRef, type ReactElement} from 'react';
import {useCanvasBacking} from '../ui/useCanvasBacking';
import type {CanvasBacking} from '../plot/paint';

interface Probe {
    backing: CanvasBacking | null;
    canvas: HTMLCanvasElement | null;
    renderCount: number;
}

// Window for ResizeObserver to settle after a style mutation. ResizeObserver
// fires on the next animation frame after layout; the fixed window yields
// the entire interval to the browser so layout and the observer pipeline
// run cleanly. vi.waitFor's setTimeout polling does not compose cleanly
// with act + ResizeObserver in the vitest browser-mode runner today.
const SETTLE_MS = 100;

const settle = (): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
});

interface FakeMediaQueryList {
    media: string;
    listeners: Set<(event: MediaQueryListEvent) => void>;
    matches: boolean;
    addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => void;
    removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => void;
}

function makeFakeMql(query: string): FakeMediaQueryList {
    const mql: FakeMediaQueryList = {
        media: query,
        listeners: new Set(),
        matches: true,
        addEventListener: (type, listener) => {
            if (type === 'change') {
                mql.listeners.add(listener);
            }
        },
        removeEventListener: (type, listener) => {
            if (type === 'change') {
                mql.listeners.delete(listener);
            }
        },
    };

    return mql;
}

describe('useCanvasBacking', () => {
    test('returns measured CSS size and DPR after mount', async () => {
        const probe: Probe = {backing: null, canvas: null, renderCount: 0};

        function Harness(): ReactElement {
            const canvasRef = useRef<HTMLCanvasElement>(null);
            probe.backing = useCanvasBacking(canvasRef);
            probe.canvas = canvasRef.current;
            probe.renderCount += 1;

            return <canvas ref={canvasRef} style={{width: '600px', height: '300px', display: 'block'}} />;
        }

        const container = document.createElement('div');
        container.style.width = '800px';
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        await act(async () => {
            root.render(<Harness />);
        });

        const canvas = probe.canvas;
        if (!canvas) {
            throw new Error('canvas was not attached');
        }
        expect(probe.backing).not.toBeNull();
        expect(probe.backing!.cssWidth).toBe(canvas.clientWidth);
        expect(probe.backing!.cssHeight).toBe(canvas.clientHeight);
        expect(probe.backing!.dpr).toBe(window.devicePixelRatio || 1);
        // Sanity floor: layout should produce non-zero CSS dimensions for an
        // inline-styled 600x300 canvas. Without this the first two equalities
        // would pass trivially against a 0/0 measurement.
        expect(probe.backing!.cssWidth).toBeGreaterThan(0);
        expect(probe.backing!.cssHeight).toBeGreaterThan(0);

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    test('updates backing when the canvas resizes', async () => {
        const probe: Probe = {backing: null, canvas: null, renderCount: 0};

        function Harness(): ReactElement {
            const canvasRef = useRef<HTMLCanvasElement>(null);
            probe.backing = useCanvasBacking(canvasRef);
            probe.canvas = canvasRef.current;
            probe.renderCount += 1;

            return <canvas ref={canvasRef} style={{width: '600px', height: '300px', display: 'block'}} />;
        }

        const container = document.createElement('div');
        container.style.width = '800px';
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        await act(async () => {
            root.render(<Harness />);
        });

        const canvas = probe.canvas;
        if (!canvas) {
            throw new Error('canvas was not attached');
        }
        const initialWidth = probe.backing!.cssWidth;

        await act(async () => {
            canvas.style.width = '400px';
            await settle();
        });

        expect(probe.backing!.cssWidth).not.toBe(initialWidth);
        expect(probe.backing!.cssWidth).toBe(canvas.clientWidth);
        expect(probe.backing!.cssHeight).toBe(canvas.clientHeight);

        await act(async () => {
            root.unmount();
        });
        container.remove();
    });

    test('rearms matchMedia on a DPR change event', async () => {
        // The hook subscribes to (resolution: <dpr>dppx) and rearms with a
        // fresh MQL whenever the listener fires. In jsdom or real browsers
        // we can't trigger an actual DPR change, so this test mocks
        // window.matchMedia to record every MQL ever created and dispatches
        // synthetic change events to drive the rearm logic.
        const created: FakeMediaQueryList[] = [];
        const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
            const mql = makeFakeMql(query);
            created.push(mql);

            return mql as unknown as MediaQueryList;
        });

        const probe: Probe = {backing: null, canvas: null, renderCount: 0};
        function Harness(): ReactElement {
            const canvasRef = useRef<HTMLCanvasElement>(null);
            probe.backing = useCanvasBacking(canvasRef);
            probe.renderCount += 1;

            return <canvas ref={canvasRef} style={{width: '600px', height: '300px', display: 'block'}} />;
        }

        const container = document.createElement('div');
        container.style.width = '800px';
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        try {
            await act(async () => {
                root.render(<Harness />);
            });

            // After mount, exactly one MQL exists with one listener.
            expect(created.length).toBe(1);
            expect(created[0]!.listeners.size).toBe(1);

            // Synthesise a change event on the active listener.
            const firstListener = [...created[0]!.listeners][0]!;
            await act(async () => {
                firstListener({} as MediaQueryListEvent);
            });

            // The rearm contract: the original listener is detached and a
            // fresh MQL is subscribed so the next DPR change is observed.
            expect(created.length).toBe(2);
            expect(created[0]!.listeners.size).toBe(0);
            expect(created[1]!.listeners.size).toBe(1);

            // A second rearm cycle proves the loop is not single-shot.
            const secondListener = [...created[1]!.listeners][0]!;
            await act(async () => {
                secondListener({} as MediaQueryListEvent);
            });

            expect(created.length).toBe(3);
            expect(created[1]!.listeners.size).toBe(0);
            expect(created[2]!.listeners.size).toBe(1);

            // Unmount detaches the active listener, leaving zero stragglers.
            await act(async () => {
                root.unmount();
            });
            expect(created[2]!.listeners.size).toBe(0);
        } finally {
            matchMediaSpy.mockRestore();
            container.remove();
        }
    });

    test('cleans up subscriptions across a strict-mode mount cycle', async () => {
        // React 19 dev strict mode mounts -> cleans up -> mounts again. The
        // hook's useLayoutEffect must shed its first MQL listener before the
        // second setup runs; otherwise the rearm dance would carry stale
        // subscriptions in dev builds.
        const created: FakeMediaQueryList[] = [];
        const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
            const mql = makeFakeMql(query);
            created.push(mql);

            return mql as unknown as MediaQueryList;
        });

        const probe: Probe = {backing: null, canvas: null, renderCount: 0};
        function Harness(): ReactElement {
            const canvasRef = useRef<HTMLCanvasElement>(null);
            probe.backing = useCanvasBacking(canvasRef);
            probe.renderCount += 1;

            return <canvas ref={canvasRef} style={{width: '600px', height: '300px', display: 'block'}} />;
        }

        const container = document.createElement('div');
        container.style.width = '800px';
        document.body.appendChild(container);
        const root: Root = createRoot(container);
        try {
            await act(async () => {
                root.render(
                    <StrictMode>
                        <Harness />
                    </StrictMode>,
                );
            });

            // Two MQLs created across the strict-mode cycle; the first was
            // cleaned up, only the second carries a live listener.
            expect(created.length).toBe(2);
            expect(created[0]!.listeners.size).toBe(0);
            expect(created[1]!.listeners.size).toBe(1);

            await act(async () => {
                root.unmount();
            });
            expect(created[1]!.listeners.size).toBe(0);
        } finally {
            matchMediaSpy.mockRestore();
            container.remove();
        }
    });
});
