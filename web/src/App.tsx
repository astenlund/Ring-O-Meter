import {type CSSProperties, useCallback, useMemo, useRef, useState} from 'react';
import {DeviceSetup, type DeviceSelection} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type PitchPlotHandle, type VoiceEntry} from './ui/PitchPlot';
import {useFrameState} from './session/useFrameState';
import {useVoiceChannels, type VoiceChannelSlot} from './audio/useVoiceChannels';
import type {FrameRingReader} from './session/frameRing';

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
    const {latest, registerReader, unregisterReader, setReaderOffset} = useFrameState();
    const plotHandleRef = useRef<PitchPlotHandle | null>(null);

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

    const handleFrameSourceReady = useCallback(
        (channelId: string, reader: FrameRingReader, perfNowAtContextTimeZero: number) => {
            registerReader(channelId, reader);
            // Forward the same SAB that VoiceChannel created for the
            // worklet to the plot worker - both sides must read/write
            // the same ring or the plot paints nothing.
            plotHandleRef.current?.attachChannel(channelId, reader.sab, perfNowAtContextTimeZero);
        },
        [registerReader],
    );

    const handleFrameSourceGone = useCallback((channelId: string) => {
        unregisterReader(channelId);
        plotHandleRef.current?.detachChannel(channelId);
    }, [unregisterReader]);

    const handleFrameSourceRebased = useCallback(
        (channelId: string, perfNowAtContextTimeZero: number) => {
            setReaderOffset(channelId, perfNowAtContextTimeZero);
            plotHandleRef.current?.rebaseChannel(channelId, perfNowAtContextTimeZero);
        },
        [setReaderOffset],
    );

    useVoiceChannels(slots, handleFrameSourceReady, handleFrameSourceGone, handleFrameSourceRebased);

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
                windowMs={PLOT_WINDOW_MS}
                handleRef={plotHandleRef}
            />
        </main>
    );
}
