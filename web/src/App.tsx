import {type CSSProperties, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {DeviceSetup, type DeviceSelection} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type PitchPlotHandle} from './ui/PitchPlot';
import {slotsToVoices} from './ui/rosterToVoices';
import {useFrameState} from './audio/useFrameState';
import {useVoiceChannels, type VoiceChannelSlot} from './audio/useVoiceChannels';
import {FrameSourceRegistry} from './audio/frameSourceRegistry';

const PLOT_WINDOW_MS = 10_000;

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
    const {latest, registerReader, unregisterReader} = useFrameState();
    const plotHandleRef = useRef<PitchPlotHandle | null>(null);
    // One registry instance per App lifetime, fed by useVoiceChannels and
    // multicasting to two subscribers (frame state + plot worker) today.
    // Slice 1's SignalR publish sink subscribes through the same surface.
    const [registry] = useState(() => new FrameSourceRegistry());

    // channelId is a client-minted GUID per slot so slice 1's aggregator
    // (which keys LatestPerChannel by channelId) cannot collide across
    // publishers. Minted inside the confirm handler rather than a useMemo:
    // useMemo is documented as a best-effort cache, so a future React
    // re-evaluation would regenerate every channelId and desync every key
    // in the worker's rings from the still-arriving frames. One-shot
    // event handler is the correct place for non-idempotent work.
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

    useVoiceChannels(slots, registry);

    useEffect(() => {
        return registry.subscribe({
            onReady: (channelId, _source, reader) => registerReader(channelId, reader),
            onRebased: () => undefined,
            onGone: (channelId) => unregisterReader(channelId),
        });
    }, [registry, registerReader, unregisterReader]);

    useEffect(() => {
        // plotHandleRef.current is read at event time, not effect time, so
        // subscribe ordering vs PitchPlot's effect (which populates the ref)
        // is irrelevant — late-arriving events still see the live handle, and
        // any event that arrives before the ref is populated no-ops gracefully.
        return registry.subscribe({
            onReady: (channelId, source, _reader) =>
                plotHandleRef.current?.attachChannel(channelId, source),
            onRebased: (channelId, epochOffsetMs) =>
                plotHandleRef.current?.rebaseChannel(channelId, epochOffsetMs),
            onGone: (channelId) => plotHandleRef.current?.detachChannel(channelId),
        });
    }, [registry]);

    const voices = useMemo(() => slotsToVoices(slots ?? []), [slots]);

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
                windowMs={PLOT_WINDOW_MS}
                handleRef={plotHandleRef}
            />
        </main>
    );
}
