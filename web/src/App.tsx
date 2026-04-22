import {type CSSProperties, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {DeviceSetup, type DeviceSelection} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type PitchPlotHandle, type VoiceEntry} from './ui/PitchPlot';
import {useFrameState} from './session/useFrameState';
import {useVoiceChannels, type VoiceChannelSlot} from './audio/useVoiceChannels';
import {FrameRingWriter, createFrameRing} from './session/frameRing';
import type {AnalysisFrame} from './wire/frames';

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
    // useFrameState coalesces per-frame setState into ~15 Hz rAF-paced
    // flushes for the NoteReadout pipeline; PlotController delivers every
    // frame to the worker via publishFrame, unthrottled.
    const {latest, applyFrame} = useFrameState();
    const plotHandleRef = useRef<PitchPlotHandle | null>(null);

    // channelId is a client-minted GUID per slot so slice 1's aggregator
    // (which keys LatestPerChannel by channelId) cannot collide across
    // publishers. Minted inside the confirm handler rather than a useMemo:
    // useMemo is documented as a best-effort cache, so a future React
    // re-evaluation would regenerate every channelId and desync every key
    // in the worker's buffers from the still-arriving frames. One-shot
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

    // Per-channel plot writers live here in Task 7 because the worklet
    // is not yet writing directly (Task 8 moves it there). Each slot
    // transition creates a fresh SAB + writer and publishes the SAB
    // over to the plot worker via attachChannel; handleFrame then
    // writes into the writer per frame. When Task 8 lands, this ref
    // map disappears and the worklet publishes straight into the SAB.
    const writersRef = useRef<Record<string, FrameRingWriter>>({});

    useEffect(() => {
        const handle = plotHandleRef.current;
        if (!handle) {
            return;
        }
        const nextWriters: Record<string, FrameRingWriter> = {};
        for (const slot of slots ?? []) {
            const existing = writersRef.current[slot.channelId];
            if (existing) {
                nextWriters[slot.channelId] = existing;
            } else {
                const sab = createFrameRing();
                nextWriters[slot.channelId] = new FrameRingWriter(sab);
                // Offset is 0 in this task: perfNowCaptureMs is already
                // in main's paint epoch. Task 8 computes a real offset
                // when stamping moves to the worklet.
                handle.attachChannel(slot.channelId, sab, 0);
            }
        }
        for (const existingChannelId of Object.keys(writersRef.current)) {
            if (!nextWriters[existingChannelId]) {
                handle.detachChannel(existingChannelId);
            }
        }
        writersRef.current = nextWriters;
    }, [slots]);

    const handleFrame = useCallback((frame: AnalysisFrame, perfNowCaptureMs: number) => {
        applyFrame(frame);
        writersRef.current[frame.channelId]?.publish(
            perfNowCaptureMs,
            frame.fundamentalHz,
            frame.confidence,
        );
    }, [applyFrame]);

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
                windowMs={PLOT_WINDOW_MS}
                handleRef={plotHandleRef}
            />
        </main>
    );
}
