import {type CSSProperties, type RefObject, useEffect, useRef} from 'react';
import {PlotController} from '../plot/plotController';
import type {VoiceEntry} from '../plot/plotMessages';

export type {VoiceEntry};

export interface PitchPlotHandle {
    attachChannel(channelId: string, sab: SharedArrayBuffer, perfNowAtContextTimeZero: number): void;
    detachChannel(channelId: string): void;
    rebaseChannel(channelId: string, perfNowAtContextTimeZero: number): void;
}

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
// canvas to the worker and spawns it; forwards ResizeObserver + DPR
// changes via setBacking; forwards voices changes via setRoster.
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

    useEffect(() => {
        pendingUnmountRef.current = false;
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        if (!controllerRef.current) {
            const fresh = new PlotController();
            const dpr = window.devicePixelRatio || 1;
            fresh.attach(canvas, {
                voices,
                backing: {cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight, dpr},
                windowMs,
                minHz,
                maxHz,
            });
            controllerRef.current = fresh;
        }
        const controller = controllerRef.current;
        handleRef.current = {
            attachChannel(channelId, sab, perfNowAtContextTimeZero) {
                controller.attachChannel(channelId, sab, perfNowAtContextTimeZero);
            },
            detachChannel(channelId) {
                controller.detachChannel(channelId);
            },
            rebaseChannel(channelId, perfNowAtContextTimeZero) {
                controller.rebaseChannel(channelId, perfNowAtContextTimeZero);
            },
        };

        const observer = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) {
                return;
            }
            const box = entry.contentBoxSize?.[0];
            const w = box ? box.inlineSize : entry.contentRect.width;
            const h = box ? box.blockSize : entry.contentRect.height;
            controller.setBacking(w, h, window.devicePixelRatio || 1);
        });
        observer.observe(canvas);

        let mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        const onDprChange = () => {
            controller.setBacking(canvas.clientWidth, canvas.clientHeight, window.devicePixelRatio || 1);
            mql.removeEventListener('change', onDprChange);
            mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
            mql.addEventListener('change', onDprChange);
        };
        mql.addEventListener('change', onDprChange);

        return () => {
            observer.disconnect();
            mql.removeEventListener('change', onDprChange);
            handleRef.current = null;
            pendingUnmountRef.current = true;
            queueMicrotask(() => {
                if (pendingUnmountRef.current && controllerRef.current) {
                    controllerRef.current.dispose();
                    controllerRef.current = null;
                }
            });
        };
        // Attach runs once per controller lifetime. Voices changes flow
        // via the roster effect below; windowMs / minHz / maxHz are
        // structurally fixed per mounted canvas.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        controllerRef.current?.setRoster(voices);
    }, [voices]);

    return <canvas ref={canvasRef} style={canvasStyle} />;
}
