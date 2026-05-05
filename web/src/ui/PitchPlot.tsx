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

// Default plot range covers C2 (65.41 Hz) to C6 (1046.50 Hz): four full
// octaves spanning the floor of barbershop bass (rarely below C2 even
// on harmonic-7 chord roots) and well above any sung fundamental at the
// top, leaving diagnostic headroom for transient octave-stabilizer
// readings without losing readability of the typical ~80-600 Hz coaching
// range.
const DEFAULT_MIN_HZ = 65.41;
const DEFAULT_MAX_HZ = 1046.50;

export interface PitchPlotProps {
    voices: ReadonlyArray<VoiceEntry>;
    windowMs: number;
    minHz?: number;
    maxHz?: number;
    handleRef: RefObject<PitchPlotHandle | null>;
    useUnderlay?: boolean;
    rendererWorkerUrl?: string;
    // Caller-driven sizing. The outer container fills 100% of whatever
    // the parent allocates by default; pass style={{height: 360}} (or
    // any flex shape) to override. The pre-Task-13 component baked
    // height: 360 into the outer div which prevented the parent from
    // sizing it via flex / aspect-ratio / explicit pixels.
    style?: CSSProperties;
    // Optional pre-constructed controller. When supplied, this component
    // does NOT construct or dispose its own; the caller owns the
    // lifecycle. Used by Task 14's lifted PlotController so VowelPlot
    // and PitchPlot share the same render worker (one device, one
    // submit per frame). When omitted, we fall back to the historical
    // self-construct shape so consumers that haven't migrated stay
    // working.
    controller?: PlotController;
}

const canvasStyle: CSSProperties = {
    width: '100%',
    height: '100%',
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
    minHz = DEFAULT_MIN_HZ,
    maxHz = DEFAULT_MAX_HZ,
    handleRef,
    useUnderlay = false,
    rendererWorkerUrl,
    style,
    controller,
}: PitchPlotProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const underlayRef = useRef<HTMLCanvasElement>(null);
    const controllerRef = useRef<PlotController | null>(null);
    // Tracks whether THIS component constructed the controller or
    // received it via prop. Disposal is gated on ownership: a caller-
    // supplied controller's lifecycle belongs to the caller (Task 14's
    // App-level PlotController is shared with VowelPlot, so disposing
    // here would tear down VowelPlot's render path too).
    const ownsControllerRef = useRef(false);
    const pendingUnmountRef = useRef(false);
    const backing = useCanvasBacking(canvasRef);

    useEffect(() => {
        pendingUnmountRef.current = false;
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        if (!controllerRef.current) {
            if (controller) {
                controllerRef.current = controller;
                ownsControllerRef.current = false;
            } else {
                const fresh = new PlotController(rendererWorkerUrl);
                controllerRef.current = fresh;
                ownsControllerRef.current = true;
            }
            controllerRef.current.attach(canvas, {voices, backing, windowMs, minHz, maxHz});
        }
        handleRef.current = controllerRef.current;

        return () => {
            handleRef.current = null;
            pendingUnmountRef.current = true;
            queueMicrotask(() => {
                if (!pendingUnmountRef.current) {
                    return;
                }
                // Real unmount: clear the ref unconditionally so a
                // future remount re-attaches. Dispose only if we own
                // the controller; a caller-supplied one outlives this
                // component.
                const c = controllerRef.current;
                const owns = ownsControllerRef.current;
                controllerRef.current = null;
                ownsControllerRef.current = false;
                if (c && owns) {
                    c.dispose();
                }
            });
        };
        // Attach runs once per controller lifetime. Backing changes flow
        // via the setBacking effect below; voices via the roster effect;
        // windowMs / minHz / maxHz are structurally fixed per mounted
        // canvas. The `controller` prop is expected to be stable across
        // the component's lifetime; mid-life swaps are not supported.
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

    // Underlay paint: when the WebGPU renderer is active, the WebGPU
    // canvas only renders dynamic traces. Static elements (background,
    // grid, legend) live on the underlay <canvas> sitting absolutely
    // behind it; the controller paints them via setUnderlay /
    // setUnderlayBacking on roster + size changes. Skipped entirely on
    // the 2D arm (useUnderlay=false), where the top 2D worker paints
    // its own grid + legend each frame.
    // Two-effect split mirrors VowelPlot.tsx: ctx + opts registration
    // runs only when the registration shape changes; backing
    // propagation runs on size changes. Fusing them into a single
    // effect on `[useUnderlay, voices, minHz, maxHz, backing]` would
    // call `setUnderlay(ctx, opts)` on every backing change, which
    // immediately calls `repaintUnderlay()` against the still-stale
    // `underlayBacking` (the next line then updates it and repaints
    // again with correct dims). Result is two paints per resize, the
    // first against stale dims.
    useEffect(() => {
        if (!useUnderlay) {
            return;
        }
        const c = underlayRef.current;
        const ctx = c?.getContext('2d');
        if (!c || !ctx || !controllerRef.current) {
            return;
        }
        controllerRef.current.setUnderlay(ctx, {voices, minHz, maxHz});
    }, [useUnderlay, voices, minHz, maxHz]);

    useEffect(() => {
        if (!useUnderlay || !controllerRef.current) {
            return;
        }
        controllerRef.current.setUnderlayBacking(backing.cssWidth, backing.cssHeight, backing.dpr);
    }, [useUnderlay, backing]);

    return (
        <div style={{position: 'relative', width: '100%', height: '100%', ...style}}>
            {useUnderlay && (
                <canvas ref={underlayRef} style={{...canvasStyle, position: 'absolute', inset: 0}} />
            )}
            <canvas ref={canvasRef} style={{...canvasStyle, position: 'absolute', inset: 0}} />
        </div>
    );
}
