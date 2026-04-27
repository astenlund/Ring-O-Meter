import {type CSSProperties, useCallback, useMemo, useRef, useState} from 'react';
import {DeviceSetup, type DeviceSelection} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type PitchPlotHandle} from './ui/PitchPlot';
import {slotsToVoices} from './ui/rosterToVoices';
import {useFrameState} from './audio/useFrameState';
import {useVoiceChannels, type VoiceChannelSlot} from './audio/useVoiceChannels';
import type {FrameRingReader, FrameSource} from './audio/frameRing';

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
        (channelId: string, source: FrameSource, reader: FrameRingReader) => {
            registerReader(channelId, reader);
            // Forward the same source descriptor (SAB + initial epoch
            // offset) to the plot worker - both sides must read/write
            // the same ring or the plot paints nothing.
            plotHandleRef.current?.attachChannel(channelId, source);
        },
        [registerReader],
    );

    const handleFrameSourceGone = useCallback((channelId: string) => {
        unregisterReader(channelId);
        plotHandleRef.current?.detachChannel(channelId);
    }, [unregisterReader]);

    const handleFrameSourceRebased = useCallback(
        (channelId: string, epochOffsetMs: number) => {
            // The reader we registered with useFrameState is the same
            // FrameRingReader instance VoiceChannel owns (identity, not
            // a copy), and VoiceChannel.handleStateChange already
            // mutated its offset before firing this callback. The plot
            // worker's reader is a DIFFERENT instance over the same SAB
            // (class instances cannot cross the worker boundary) and
            // must be synced independently, which is what this does.
            plotHandleRef.current?.rebaseChannel(channelId, epochOffsetMs);
        },
        [],
    );

    useVoiceChannels(slots, {
        onFrameSourceReady: handleFrameSourceReady,
        onFrameSourceGone: handleFrameSourceGone,
        onFrameSourceRebased: handleFrameSourceRebased,
    });

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
