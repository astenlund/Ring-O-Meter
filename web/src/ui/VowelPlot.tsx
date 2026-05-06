import {type CSSProperties, useEffect, useRef} from 'react';
import {PlotController} from '../plot/plotController';
import type {Renderer} from '../plot/renderer';
import {useCanvasBacking} from './useCanvasBacking';

export interface VowelPlotProps {
    // App-level shared PlotController. Unlike PitchPlot, VowelPlot does
    // NOT have a self-construct fallback: this component shipped after
    // the controller-hoist that lifted PlotController to App so it can
    // be shared with PitchPlot, and there is no legacy consumer that
    // needs the back-compat shape. Required so the inter-singer F1/F2
    // polygon is always wired into the same render worker as the trace
    // (one device, one queue, one submit per frame).
    controller: PlotController;
    // Discriminated-union renderer choice; the underlay canvas is
    // mounted iff `renderer.kind === 'webgpu'`. Mirrors PitchPlot:
    // on the WebGPU arm, a 2D underlay canvas behind the WebGPU canvas
    // carries the static chrome (gridlines + axis labels); on the 2D
    // arm the worker paints chrome inline each frame and no
    // main-thread underlay is mounted.
    renderer: Renderer;
    style?: CSSProperties;
}

const canvasStyle: CSSProperties = {
    width: '100%',
    height: '100%',
    borderRadius: 6,
    border: '1px solid #444',
};

// Inter-singer F1/F2 polygon visualization. Mirror of PitchPlot for
// the vowel coaching surface: one main-thread component owning canvas
// refs, hooked into useCanvasBacking for DPR/size tracking, attached
// to the lifted PlotController. The actual paint runs inside the plot
// worker (one shared with PitchPlot via the controller); this
// component only manages canvas mount + lifecycle messages.
//
// Strict-mode safety. transferControlToOffscreen() is one-shot per
// <canvas> element. attachedRef gates the attach so the strict-mode
// double-mount does not call attachVowelCanvas twice on the same
// canvas. No deferred-dispose dance is needed here because the
// controller's lifetime is owned by App, not by this component:
// disposal happens when App unmounts (rare in production, expected in
// dev strict-mode), at which point the controller terminates the
// shared worker and the vowel canvas is implicitly released.
export function VowelPlot({controller, renderer, style}: VowelPlotProps) {
    const useUnderlay = renderer.kind === 'webgpu';
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const underlayRef = useRef<HTMLCanvasElement>(null);
    const attachedRef = useRef(false);
    const backing = useCanvasBacking(canvasRef);

    useEffect(() => {
        if (attachedRef.current) {
            return;
        }
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        controller.attachVowelCanvas(canvas);
        attachedRef.current = true;
        // No teardown: VowelPlot does not own the controller. App owns
        // it via useState; controller.dispose() (which terminates the
        // shared worker) is responsible for releasing the OffscreenCanvas
        // we transferred above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!attachedRef.current) {
            return;
        }
        controller.setVowelBacking(backing.cssWidth, backing.cssHeight, backing.dpr);
    }, [backing, controller]);

    // One-shot ctx registration: setVowelUnderlay sets the controller's
    // ctx ref, which is stable for the underlay canvas's lifetime. This
    // effect runs only on mount + useUnderlay-toggle, NOT on every
    // backing change - registering the same ctx repeatedly would trigger
    // a paint with stale dims (because vowelUnderlayBacking still holds
    // the previous frame's values until the second effect updates it).
    useEffect(() => {
        if (!useUnderlay) {
            return;
        }
        const c = underlayRef.current;
        const ctx = c?.getContext('2d');
        if (!c || !ctx) {
            return;
        }
        controller.setVowelUnderlay(ctx);
    }, [useUnderlay, controller]);

    // Backing propagation: separate from the ctx registration so backing
    // changes paint exactly once with the correct dims.
    useEffect(() => {
        if (!useUnderlay) {
            return;
        }
        controller.setVowelUnderlayBacking(backing.cssWidth, backing.cssHeight, backing.dpr);
    }, [useUnderlay, backing, controller]);

    return (
        <div style={{position: 'relative', width: '100%', height: '100%', ...style}}>
            {useUnderlay && (
                <canvas ref={underlayRef} style={{...canvasStyle, position: 'absolute', inset: 0}} />
            )}
            {/* `data-role="vowel"` is the e2e canvas-content assertion's
              * locator; if it ever needs to change, update the queries
              * in web/e2e/support/smoothness.ts in lockstep. */}
            <canvas ref={canvasRef} data-role="vowel" style={{...canvasStyle, position: 'absolute', inset: 0}} />
        </div>
    );
}
