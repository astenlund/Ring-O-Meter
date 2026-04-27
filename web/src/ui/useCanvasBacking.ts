import {type RefObject, useLayoutEffect, useState} from 'react';
import type {CanvasBacking} from '../plot/paint';

const PLACEHOLDER: CanvasBacking = {cssWidth: 0, cssHeight: 0, dpr: 1};

// Tracks a canvas's CSS-pixel size + device pixel ratio as React state
// so consumers can drive imperative downstream APIs (e.g.,
// PlotController.setBacking) from a sibling [backing]-deps useEffect
// without re-implementing the ResizeObserver + matchMedia rearm dance
// per call site. The matchMedia rearm pattern (rebuild a fresh MQL on
// every change so the next DPR step is observed) is the non-obvious
// piece that justifies the hook even though it has one caller today;
// useLayoutEffect runs the initial measurement synchronously after
// commit so PitchPlot's first paint sees real dimensions, not the
// placeholder.
export function useCanvasBacking(
    canvasRef: RefObject<HTMLCanvasElement | null>,
): CanvasBacking {
    const [backing, setBacking] = useState<CanvasBacking>(PLACEHOLDER);

    useLayoutEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }

        const readDpr = (): number => window.devicePixelRatio || 1;

        const update = (cssWidth: number, cssHeight: number, dpr: number): void => {
            setBacking((prev) =>
                prev.cssWidth === cssWidth && prev.cssHeight === cssHeight && prev.dpr === dpr
                    ? prev
                    : {cssWidth, cssHeight, dpr},
            );
        };

        update(canvas.clientWidth, canvas.clientHeight, readDpr());

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) {
                return;
            }
            const box = entry.contentBoxSize?.[0];
            const cssWidth = box ? box.inlineSize : entry.contentRect.width;
            const cssHeight = box ? box.blockSize : entry.contentRect.height;
            update(cssWidth, cssHeight, readDpr());
        });
        observer.observe(canvas);

        let mql = window.matchMedia(`(resolution: ${readDpr()}dppx)`);
        const onDprChange = (): void => {
            update(canvas.clientWidth, canvas.clientHeight, readDpr());
            mql.removeEventListener('change', onDprChange);
            mql = window.matchMedia(`(resolution: ${readDpr()}dppx)`);
            mql.addEventListener('change', onDprChange);
        };
        mql.addEventListener('change', onDprChange);

        return () => {
            observer.disconnect();
            mql.removeEventListener('change', onDprChange);
        };
    }, [canvasRef]);

    return backing;
}
