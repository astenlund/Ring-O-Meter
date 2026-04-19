import {type CSSProperties, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {DeviceSetup, type DeviceSelection} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type TraceSample, type VoiceStyle} from './ui/PitchPlot';
import {useVoiceChannels} from './audio/useVoiceChannels';
import type {AudioInputDevice} from './audio/deviceManager';
import type {AnalysisFrame} from './wire/frames';

// Plot window and the trace cap derived from it. If a voice ever publishes
// faster than MAX_PUBLISH_HZ the ring buffer will shed the oldest frame,
// which is the intended behaviour; 60 Hz is a safe ceiling since the
// worklet currently publishes at ~47 Hz.
const PLOT_WINDOW_MS = 10_000;
const MAX_PUBLISH_HZ = 60;
const MAX_TRACE_SAMPLES = Math.ceil((PLOT_WINDOW_MS * MAX_PUBLISH_HZ) / 1000);

const SLOT_COLORS = ['#5cf', '#fc5'] as const;

const mainStyle: CSSProperties = {
    padding: 24,
    fontFamily: 'sans-serif',
    color: '#eee',
    background: '#181818',
    minHeight: '100vh',
};

interface Slot {
    channelId: string;
    voiceLabel: string;
    device: AudioInputDevice;
    color: string;
}

export function App() {
    const [selection, setSelection] = useState<DeviceSelection | null>(null);
    const [latest, setLatest] = useState<Record<string, AnalysisFrame>>({});

    // Trace samples accumulate at the worklet's publish rate (~47 Hz per
    // voice). Storing them in a ref (mutated in place) instead of React
    // state avoids a setState + reconciliation every 21 ms; PitchPlot
    // reads the ref from its rAF paint loop and re-renders of the App
    // component only happen when `latest` changes (driving NoteReadout).
    const tracesRef = useRef<Record<string, TraceSample[]>>({});

    // channelId is a client-minted GUID per selection so slice 1's aggregator
    // (which keys LatestPerChannel by channelId) cannot collide across
    // publishers. Regenerated on each fresh device selection; stable across
    // re-renders. Keeping this shape in slice 0 means slice 1's wire upgrade
    // is zero-delta on the App side.
    const slots = useMemo<Slot[] | null>(() => {
        if (!selection) {
            return null;
        }

        return [
            {channelId: crypto.randomUUID(), voiceLabel: 'Voice 1', device: selection.voice1, color: SLOT_COLORS[0]},
            {channelId: crypto.randomUUID(), voiceLabel: 'Voice 2', device: selection.voice2, color: SLOT_COLORS[1]},
        ];
    }, [selection]);

    const handleFrame = useCallback((frame: AnalysisFrame) => {
        setLatest((prev) => ({...prev, [frame.channelId]: frame}));

        const buf = tracesRef.current[frame.channelId] ?? [];
        buf.push({
            tsMs: performance.now(),
            fundamentalHz: frame.fundamentalHz,
            confidence: frame.confidence,
        });
        // In-place trim keeps the trace bounded without re-allocating the
        // whole array every frame.
        if (buf.length > MAX_TRACE_SAMPLES) {
            buf.splice(0, buf.length - MAX_TRACE_SAMPLES);
        }
        tracesRef.current[frame.channelId] = buf;
    }, []);

    // Reset both per-channel stores when the device selection changes so
    // stale channelIds from a previous selection do not accumulate in
    // `latest` (spread copies them forever) or in `tracesRef` (PitchPlot
    // would iterate channelIds the voices map no longer knows about).
    // Runs before useVoiceChannels' effect on the same dependency, so
    // downstream frames land in fresh stores.
    useEffect(() => {
        tracesRef.current = {};
        setLatest({});
    }, [slots]);

    const channelSlots = useMemo(
        () => slots?.map(({channelId, voiceLabel, device}) => ({channelId, voiceLabel, deviceId: device.deviceId})) ?? null,
        [slots],
    );
    useVoiceChannels(channelSlots, handleFrame);

    const voices = useMemo<Record<string, VoiceStyle>>(() => {
        const out: Record<string, VoiceStyle> = {};
        for (const slot of slots ?? []) {
            out[slot.channelId] = {label: slot.device.label, color: slot.color};
        }

        return out;
    }, [slots]);

    if (!slots) {
        return (
            <main style={mainStyle}>
                <h1>Ring-O-Meter</h1>
                <DeviceSetup onConfirm={setSelection} />
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
                            deviceLabel={slot.device.label}
                            fundamentalHz={frame?.fundamentalHz ?? 0}
                            confidence={frame?.confidence ?? 0}
                        />
                    );
                })}
            </div>
            <PitchPlot
                voices={voices}
                samplesRef={tracesRef}
                windowMs={PLOT_WINDOW_MS}
            />
        </main>
    );
}
