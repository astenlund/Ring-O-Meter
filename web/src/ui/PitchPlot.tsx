import {type CSSProperties, type RefObject, useEffect, useRef} from 'react';
import {PlotController} from '../plot/plotController';
import type {VoiceEntry} from '../plot/plotMessages';
import {useCanvasBacking} from './useCanvasBacking';

export type {VoiceEntry};

// The handle exposed to parents is exactly the channel-lifecycle subset of
// PlotController. Publishing the controller directly keeps the shape in one
// place instead of shadowing each method with a wrapper that would drift on
// signature changes.
export type PitchPlotHandle = Pick<PlotController, 'attachChannel' | 'detachChannel' | 'rebaseChannel'>;

export interface PitchPlotProps {
    voices: ReadonlyArray<VoiceEntry>;
    windowMs: number;
    minHz?: number;
    maxHz?: number;
    handleRef: RefObject<PitchPlotHandle | null>;
}

const canvasStyle: CSSProperties = {
    width: '100%',
    height: 360,
    borderRadius: 6,
    border: '1px solid #444',
};

// Thin React shell over PlotController. On first mount, transfers the
// canvas to the worker and spawns it; forwards size + DPR changes from
// useCanvasBacking via setBacking; forwards voices changes via setRoster.
//
// Strict-mode safety. transferControlToOffscreen() is one-shot per
// <canvas> element and throws InvalidStateError on a second call.
// React 19 dev strict mode double-invokes effects (mount -> cleanup ->
// mount) against the same DOM element, so the attach path must be
// idempotent:
//   1. controllerRef persists across strict-mode re-entry; if the
//      controller already exists on a re-mount, attach is skipped.
//   2. cleanup defers controller.dispose() via queueMicrotask; if a
//      subsequent mount arms the effect first (strict-mode re-entry),
//      the deferred dispose sees pendingUnmountRef cleared and skips.
//      Real unmounts dispose normally because no re-mount clears the
//      flag.
export function PitchPlot({
    voices,
    windowMs,
    minHz = 80,
    maxHz = 600,
    handleRef,
}: PitchPlotProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const controllerRef = useRef<PlotController | null>(null);
    const pendingUnmountRef = useRef(false);
    const backing = useCanvasBacking(canvasRef);

    useEffect(() => {
        pendingUnmountRef.current = false;
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        if (!controllerRef.current) {
            const fresh = new PlotController();
            fresh.attach(canvas, {voices, backing, windowMs, minHz, maxHz});
            controllerRef.current = fresh;
        }
        handleRef.current = controllerRef.current;

        return () => {
            handleRef.current = null;
            pendingUnmountRef.current = true;
            queueMicrotask(() => {
                if (pendingUnmountRef.current && controllerRef.current) {
                    controllerRef.current.dispose();
                    controllerRef.current = null;
                }
            });
        };
        // Attach runs once per controller lifetime. Backing changes flow
        // via the setBacking effect below; voices via the roster effect;
        // windowMs / minHz / maxHz are structurally fixed per mounted
        // canvas.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // First fire on initial mount is redundant with the `attach({backing})`
    // call above (same values, fresh worker), but the cost is a single
    // postMessage and the unconditional shape keeps the resize-driven
    // updates from carrying a "skip the first one" guard ref.
    useEffect(() => {
        controllerRef.current?.setBacking(backing.cssWidth, backing.cssHeight, backing.dpr);
    }, [backing]);

    useEffect(() => {
        controllerRef.current?.setRoster(voices);
    }, [voices]);

    return <canvas ref={canvasRef} style={canvasStyle} />;
}
