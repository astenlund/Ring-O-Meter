import {type CSSProperties, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {DeviceSetup, type DeviceSelection} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type VoiceEntry} from './ui/PitchPlot';
import {MAX_PUBLISH_HZ} from './audio/constants';
import {TraceBuffer} from './session/traceBuffer';
import {useVoiceChannels, type VoiceChannelSlot} from './audio/useVoiceChannels';
import type {AnalysisFrame} from './wire/frames';

// Plot window and the trace cap derived from it. If a voice ever publishes
// faster than MAX_PUBLISH_HZ the ring buffer will overwrite its oldest
// frame, which is the intended behaviour.
const PLOT_WINDOW_MS = 10_000;
const MAX_TRACE_SAMPLES = Math.ceil((PLOT_WINDOW_MS * MAX_PUBLISH_HZ) / 1000);

const SLOT_COLORS = ['#5cf', '#fc5'] as const;

const mainStyle: CSSProperties = {
    padding: 24,
    fontFamily: 'sans-serif',
    color: '#eee',
    background: '#181818',
    minHeight: '100vh',
};

// Slot widens VoiceChannelSlot with the render-layer fields (deviceLabel
// for readouts/legend, color for the plot trace). `extends` documents the
// contract explicitly; without it, assignability is only structural and a
// future rename of VoiceChannelSlot.deviceId would silently break the
// relationship.
interface Slot extends VoiceChannelSlot {
    deviceLabel: string;
    color: string;
}

export function App() {
    const [latest, setLatest] = useState<Record<string, AnalysisFrame>>({});

    // Trace samples accumulate at the worklet's publish rate (~47 Hz per
    // voice). Storing them in a ref (mutated in place via TraceBuffer)
    // instead of React state avoids a setState + reconciliation every 21
    // ms; PitchPlot reads the ref from its rAF paint loop and re-renders
    // of the App component only happen when `latest` changes (driving
    // NoteReadout).
    const buffersRef = useRef<Record<string, TraceBuffer>>({});

    // channelId is a client-minted GUID per slot so slice 1's aggregator
    // (which keys LatestPerChannel by channelId) cannot collide across
    // publishers. Minted inside the confirm handler rather than a useMemo:
    // useMemo is documented as a best-effort cache, so a future React
    // re-evaluation would regenerate every channelId and desync every key
    // in `buffersRef` from the still-arriving frames. One-shot event
    // handler is the correct place for non-idempotent work.
    const [slots, setSlots] = useState<Slot[] | null>(null);

    const handleDeviceConfirm = useCallback((selection: DeviceSelection) => {
        setSlots([
            {
                channelId: crypto.randomUUID(),
                voiceLabel: 'Voice 1',
                deviceId: selection.voice1.deviceId,
                deviceLabel: selection.voice1.label,
                color: SLOT_COLORS[0],
            },
            {
                channelId: crypto.randomUUID(),
                voiceLabel: 'Voice 2',
                deviceId: selection.voice2.deviceId,
                deviceLabel: selection.voice2.label,
                color: SLOT_COLORS[1],
            },
        ]);
    }, []);

    const handleFrame = useCallback((frame: AnalysisFrame) => {
        setLatest((prev) => ({...prev, [frame.channelId]: frame}));
        buffersRef.current[frame.channelId]?.push(performance.now(), frame.fundamentalHz, frame.confidence);
    }, []);

    // Resets the per-channel stores when the device selection changes and
    // pre-populates a TraceBuffer for every slot, so stale channelIds from
    // a previous selection cannot leak into `latest` or `buffersRef` and
    // `handleFrame` does not need a lazy-allocation branch on every frame.
    // Runs before useVoiceChannels' effect on the same dependency, so
    // downstream frames land in fresh stores.
    useEffect(() => {
        const buffers: Record<string, TraceBuffer> = {};
        for (const slot of slots ?? []) {
            buffers[slot.channelId] = new TraceBuffer(MAX_TRACE_SAMPLES);
        }
        buffersRef.current = buffers;
        setLatest({});
    }, [slots]);

    useVoiceChannels(slots, handleFrame);

    const voices = useMemo<ReadonlyArray<VoiceEntry>>(
        () =>
            (slots ?? []).map((slot) => ({
                channelId: slot.channelId,
                label: slot.deviceLabel,
                color: slot.color,
            })),
        [slots],
    );

    if (!slots) {
        return (
            <main style={mainStyle}>
                <h1>Ring-O-Meter</h1>
                <DeviceSetup onConfirm={handleDeviceConfirm} />
            </main>
        );
    }

    return (
        <main style={mainStyle}>
            <h1>Ring-O-Meter</h1>
            <div style={{display: 'flex', gap: 16, marginBottom: 16}}>
                {slots.map((slot) => {
                    const frame = latest[slot.channelId];

                    return (
                        <NoteReadout
                            key={slot.channelId}
                            deviceLabel={slot.deviceLabel}
                            fundamentalHz={frame?.fundamentalHz ?? 0}
                            confidence={frame?.confidence ?? 0}
                        />
                    );
                })}
            </div>
            <PitchPlot
                voices={voices}
                buffersRef={buffersRef}
                windowMs={PLOT_WINDOW_MS}
            />
        </main>
    );
}
