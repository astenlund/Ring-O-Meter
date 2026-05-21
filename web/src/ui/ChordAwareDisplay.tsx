import {useEffect, useRef} from 'react';
import {type ChordIdentity} from '../wire/chord';
import {ChordLabel} from './ChordLabel';
import {RingIndicatorDot, type RingIndicatorState} from './RingIndicatorDot';
import {useCanvasBacking} from './useCanvasBacking';

export interface ChordAwareVoice {
    readonly channelId: string;
    readonly deviceLabel: string;
    readonly color: string;
}

export interface ChordAwareDisplayProps {
    chord: ChordIdentity | null;
    voices: ReadonlyArray<ChordAwareVoice>;
    residualsPerVoice: ReadonlyMap<string, number>;
    ringState: RingIndicatorState;
    onCanvasRef: (canvas: HTMLCanvasElement | null) => void;
    onBackingChange: (cssWidth: number, cssHeight: number, dpr: number) => void;
}

export function ChordAwareDisplay({
    chord,
    voices,
    residualsPerVoice,
    ringState,
    onCanvasRef,
    onBackingChange,
}: ChordAwareDisplayProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const onBackingChangeRef = useRef(onBackingChange);
    onBackingChangeRef.current = onBackingChange;

    const onCanvasRefRef = useRef(onCanvasRef);
    onCanvasRefRef.current = onCanvasRef;

    const setCanvasRef = (canvas: HTMLCanvasElement | null) => {
        canvasRef.current = canvas;
        onCanvasRefRef.current(canvas);
    };

    // Backing-state tracking lives in useCanvasBacking: it handles
    // ResizeObserver size changes AND matchMedia DPR rearm (external
    // monitor connect, browser zoom). Forwarding effect mirrors the
    // PitchPlot shape — read onBackingChange via a ref so the effect's
    // dep array stays at [backing] and doesn't re-fire on parent
    // re-renders that hand us a fresh closure.
    const backing = useCanvasBacking(canvasRef);
    useEffect(() => {
        onBackingChangeRef.current(backing.cssWidth, backing.cssHeight, backing.dpr);
    }, [backing]);

    return (
        // data-component is a stable mount marker (always present);
        // data-chord-type is only set when a chord is locked (React
        // removes the attribute on null). E2E tests use data-component
        // to assert the component is mounted regardless of lock state.
        <div data-component="chord-aware-display" data-chord-type={chord?.type ?? undefined}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <ChordLabel chord={chord} />
                <RingIndicatorDot state={ringState} />
            </div>
            <canvas ref={setCanvasRef} style={{display: 'block', width: '100%'}} />
            {voices.map(({channelId, deviceLabel}) => {
                const cents = residualsPerVoice.get(channelId);

                return (
                    <div
                        key={channelId}
                        data-voice-id={channelId}
                        data-label={deviceLabel}
                        data-cents={cents !== undefined ? cents : undefined}
                        style={{display: 'none'}}
                    />
                );
            })}
        </div>
    );
}
