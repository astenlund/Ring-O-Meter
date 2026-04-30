import {type CSSProperties, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {DeviceSetup, type DeviceSelection} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type PitchPlotHandle} from './ui/PitchPlot';
import {slotsToVoices} from './ui/rosterToVoices';
import {useFrameState} from './audio/useFrameState';
import {useVoiceChannels, type VoiceChannelSlot} from './audio/useVoiceChannels';
import {FrameSourceRegistry} from './audio/frameSourceRegistry';
// Cleanup: remove this import + fanoutConfig state + fanout branch in
// handleDeviceConfirm + trim SLOT_COLORS back to ['#5cf', '#fc5'] when
// the fanout test mode is retired (also remove FanoutGroup + fanoutGroup
// field from useVoiceChannels.ts + its FanoutVoiceChannel import; also
// rm __testing/fanoutFlag.ts, fanoutVoiceChannel.ts, fanoutWorklet.ts,
// fanoutConstants.ts).
import {parseFanoutFlag} from './__testing/fanoutFlag';
import {parseRendererFlag} from './__testing/rendererFlag';
// The static `?worker&url` import bundles the WebGPU worker chunk
// into every production build, even for users who never opt into
// ?renderer=webgpu - the URL is just a string at this layer; the
// worker is only instantiated when PlotController chooses it. The
// chunk's deadweight cost is acceptable for the prototype window;
// if Option D wins (per spec's decision tree) and the prototype is
// retired, this import is removed alongside plotWorkerWebgpu.ts.
// If the prototype graduates to production via Option C, switch to
// a dynamic `import()` guarded on the renderer flag at that point.
import webgpuWorkerUrl from './plot/plotWorkerWebgpu.ts?worker&url';

const PLOT_WINDOW_MS = 10_000;

// Four entries to support ?fanout=4 test mode. Production today only
// uses the first two (Voice 1 / Voice 2); the 3rd and 4th are consumed
// only when fanoutConfig is non-null. SLOT_COLORS[i % length] cycles if
// fanout count exceeds 4.
const SLOT_COLORS = ['#5cf', '#fc5', '#5f9', '#f5c'] as const;

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
    // Test-only: parsed once at mount so a query-string change requires a
    // reload to take effect (no live re-evaluation of the flag while a
    // session is in flight). Returns null in production. Cleanup: remove
    // this state + the parseFanoutFlag import + the fanout branch in
    // handleDeviceConfirm + the SLOT_COLORS extension.
    const [fanoutConfig] = useState(() => parseFanoutFlag(window.location.search));
    const [rendererFlag] = useState(() => parseRendererFlag(window.location.search));

    const handleDeviceConfirm = useCallback((selection: DeviceSelection) => {
        if (fanoutConfig) {
            // One physical mic + N render slots. The primary slot owns
            // the audio capture (deviceId from voice1, fanoutGroup
            // primary=true); the remaining N-1 are render-only ghosts.
            // FanoutVoiceChannel internally fires N onFrameSourceReady
            // events with these channelIds, populating the registry +
            // useFrameState + plot worker just as N real channels would.
            const channelIds = Array.from(
                {length: fanoutConfig.count},
                () => crypto.randomUUID(),
            );
            const next: Slot[] = channelIds.map((channelId, i) => ({
                channelId,
                voiceLabel: `Test ${i + 1}`,
                deviceId: selection.voice1.deviceId,
                // deviceLabel is shown in the NoteReadout + plot legend;
                // the source mic is identical for all N, so distinguish
                // by index rather than repeating the mic name N times.
                deviceLabel: `Test ${i + 1}`,
                color: SLOT_COLORS[i % SLOT_COLORS.length],
                fanoutGroup: {
                    primary: i === 0,
                    derivedChannelIds: channelIds,
                    pitchOffsetsCents: fanoutConfig.offsetsCents,
                },
            }));
            setSlots(next);

            return;
        }

        const next: Slot[] = [
            {
                channelId: crypto.randomUUID(),
                voiceLabel: 'Voice 1',
                deviceId: selection.voice1.deviceId,
                deviceLabel: selection.voice1.label,
                color: SLOT_COLORS[0],
            },
        ];
        if (selection.voice2) {
            next.push({
                channelId: crypto.randomUUID(),
                voiceLabel: 'Voice 2',
                deviceId: selection.voice2.deviceId,
                deviceLabel: selection.voice2.label,
                color: SLOT_COLORS[1],
            });
        }
        setSlots(next);
    }, [fanoutConfig]);

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
                rendererWorkerUrl={rendererFlag === 'webgpu' ? webgpuWorkerUrl : undefined}
                useUnderlay={rendererFlag === 'webgpu'}
            />
        </main>
    );
}
