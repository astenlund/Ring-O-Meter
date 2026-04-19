import {useCallback, useEffect, useMemo, useState} from 'react';
import {DeviceSetup, type DeviceSelection} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type TraceSample} from './ui/PitchPlot';
import {VoiceChannel} from './audio/voiceChannel';
import {openInputStream, type AudioInputDevice} from './audio/deviceManager';
import type {AnalysisFrame} from './wire/frames';

const MAX_TRACE_SAMPLES = 600; // 10 s at ~60 Hz max
const SLOT_COLORS = ['#5cf', '#fc5'] as const;

interface Slot {
    channelId: string;
    voiceLabel: string;
    device: AudioInputDevice;
    color: string;
}

export function App() {
    const [selection, setSelection] = useState<DeviceSelection | null>(null);
    const [latest, setLatest] = useState<Record<string, AnalysisFrame>>({});
    const [traces, setTraces] = useState<Record<string, TraceSample[]>>({});

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
        setTraces((prev) => {
            const existing = prev[frame.channelId] ?? [];
            const buf = existing.slice(-MAX_TRACE_SAMPLES + 1);
            buf.push({
                tsMs: performance.now(),
                fundamentalHz: frame.fundamentalHz,
                confidence: frame.confidence,
            });

            return {...prev, [frame.channelId]: buf};
        });
    }, []);

    useEffect(() => {
        if (!slots) {
            return;
        }

        let cancelled = false;
        const audioContext = new AudioContext({sampleRate: 48000});

        const channels = slots.map((slot) => new VoiceChannel({
            channelId: slot.channelId,
            voiceLabel: slot.voiceLabel,
            deviceId: slot.device.deviceId,
            audioContext,
            onFrame: handleFrame,
        }));

        // Open both mic streams and start both worklet-backed channels in
        // parallel; getUserMedia can cost hundreds of ms per device, so
        // serialising doubles startup latency. Each branch has its own
        // cancel checks: one before .start() runs (if the effect tore down
        // during the stream await), one after (if it tore down during the
        // worklet addModule await). Promise.allSettled (instead of all) so
        // one mic failing (e.g. permission denied) does not leave the
        // other mic's async branch running without a cleanup hook.
        Promise.allSettled(channels.map(async (channel, i) => {
            const stream = await openInputStream(slots[i].device.deviceId);
            if (cancelled) {
                stream.getTracks().forEach((t) => t.stop());

                return;
            }
            await channel.start(stream);
            if (cancelled) {
                channel.stop();
            }
        })).then((results) => {
            const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
            if (failures.length === 0) {
                return;
            }
            failures.forEach((f) => console.error('Setup failed', f.reason));
            // Any failure tears down every channel AND the AudioContext;
            // the cleanup function would not otherwise close the context
            // until slots change or the component unmounts, leaking audio
            // hardware resources while the user stares at the error.
            channels.forEach((c) => c.stop());
            audioContext.close().catch(() => undefined);
        });

        return () => {
            cancelled = true;
            channels.forEach((c) => c.stop());
            audioContext.close().catch(() => undefined);
        };
    }, [slots, handleFrame]);

    const {voiceLabels, voiceColors} = useMemo(() => {
        const labels: Record<string, string> = {};
        const colors: Record<string, string> = {};
        for (const slot of slots ?? []) {
            labels[slot.channelId] = slot.device.label;
            colors[slot.channelId] = slot.color;
        }

        return {voiceLabels: labels, voiceColors: colors};
    }, [slots]);

    if (!slots) {
        return (
            <main style={{padding: 24, fontFamily: 'sans-serif', color: '#eee', background: '#181818', minHeight: '100vh'}}>
                <h1>Ring-O-Meter</h1>
                <DeviceSetup onConfirm={setSelection} />
            </main>
        );
    }

    return (
        <main style={{padding: 24, fontFamily: 'sans-serif', color: '#eee', background: '#181818', minHeight: '100vh'}}>
            <h1>Ring-O-Meter</h1>
            <div style={{display: 'flex', gap: 16, marginBottom: 16}}>
                {slots.map((slot) => {
                    const frame = latest[slot.channelId];

                    return (
                        <NoteReadout
                            key={slot.channelId}
                            voiceLabel={slot.device.label}
                            fundamentalHz={frame?.fundamentalHz ?? 0}
                            confidence={frame?.confidence ?? 0}
                        />
                    );
                })}
            </div>
            <PitchPlot
                voiceLabels={voiceLabels}
                voiceColors={voiceColors}
                samples={traces}
            />
        </main>
    );
}
