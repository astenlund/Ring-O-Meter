import {type CSSProperties, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {DeviceSetup} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type PitchPlotHandle} from './ui/PitchPlot';
import {VowelPlot} from './ui/VowelPlot';
import {slotsToVoices} from './ui/rosterToVoices';
import {useFrameState} from './audio/useFrameState';
import {useInputDevices} from './audio/useInputDevices';
import {useVoiceChannels, type VoiceChannelSlot} from './audio/useVoiceChannels';
import {FrameSourceRegistry} from './audio/frameSourceRegistry';
import {PlotController} from './plot/plotController';
// Cleanup: remove this import + fanoutConfig state + fanout branch in
// the slot-build effect + trim SLOT_COLORS back to ['#5cf', '#fc5'] when
// the fanout test mode is retired (also remove FanoutGroup + fanoutGroup
// field from useVoiceChannels.ts + its FanoutVoiceChannel import; also
// rm __testing/fanoutFlag.ts, fanoutVoiceChannel.ts, fanoutWorklet.ts,
// fanoutConstants.ts). Do NOT also delete __testing/rendererFlag.ts -
// it is a production renderer toggle (?renderer=2d), not part of the
// fanout test mode despite living in the same directory; see the
// comment at the top of that file.
import {parseFanoutFlag} from './__testing/fanoutFlag';
import {parseRendererFlag} from './__testing/rendererFlag';
// As of 2026-04-30 WebGPU is the production default renderer; the 2D
// canvas worker remains available via ?renderer=2d. The static
// `?worker&url` imports bundle both worker chunks at build time so
// switching between them is a same-origin URL pick, not a dynamic
// import. The 2D chunk is small (~4 KB gzipped) and pays for itself
// the first time someone hits an iPad / device / driver where WebGPU
// is unavailable or undesirable.
import webgpuWorkerUrl from './plot/plotWorkerWebgpu.ts?worker&url';

// 5 s of pitch history fits in window. The previous 10 s was chosen
// for roominess but doubled the per-frame vertex count vs what the
// renderer actually needs to scroll smoothly: each rendered sample
// occupies twice the horizontal pixels at 5 s, halving the
// vertex-buffer upload size and per-frame rasterization work
// (measured ~2× reduction on the staccato moderate-frame profile).
// 5 s is still long enough to see a phrase's pitch trajectory in
// barbershop coaching contexts; the SAB ring keeps ~22 s of history
// at the worklet's ~47 Hz publish rate, so widening the window
// later is a one-constant change with no data loss.
// heuristic: plot-window-ms
const PLOT_WINDOW_MS = 5_000;

// Four entries to support ?fanout=4 test mode. Production uses the
// first entry (the single live mic); 2-4 are consumed only when
// fanoutConfig is non-null. SLOT_COLORS[i % length] cycles if fanout
// count exceeds 4.
const SLOT_COLORS = ['#5cf', '#fc5', '#5f9', '#f5c'] as const;

const DEVICE_STORAGE_KEY = 'lastDeviceId';

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
    // multicasting to three subscribers (frame state + plot worker + vowel
    // module). Slice 1's SignalR publish sink subscribes through the same
    // surface.
    const [registry] = useState(() => new FrameSourceRegistry());

    const {devices, error: devicesError} = useInputDevices();
    // selectedDeviceId is a single-source-of-truth string; the live
    // AudioInputDevice (with label) is resolved from the enumerated list
    // each render. Persisted to localStorage so dev refreshes pick up
    // the previous mic without going through a setup screen.
    const [selectedDeviceId, setSelectedDeviceIdState] = useState<string>(() =>
        localStorage.getItem(DEVICE_STORAGE_KEY) ?? '',
    );
    const setSelectedDeviceId = useCallback((id: string) => {
        setSelectedDeviceIdState(id);
        localStorage.setItem(DEVICE_STORAGE_KEY, id);
    }, []);

    // Reconcile the persisted / current selection against the live
    // device list: pick the first available device when the stored ID
    // is empty, missing from the list (mic unplugged), or never set.
    // Runs whenever the device list updates (initial probe completion,
    // USB plug/unplug). Skips work when the current selection is still
    // valid so a hot-plug of an unrelated device doesn't switch us.
    useEffect(() => {
        if (!devices || devices.length === 0) {
            return;
        }
        const valid = selectedDeviceId !== ''
            && devices.some((d) => d.deviceId === selectedDeviceId);
        if (!valid) {
            setSelectedDeviceId(devices[0].deviceId);
        }
    }, [devices, selectedDeviceId, setSelectedDeviceId]);

    const selectedDevice = useMemo(
        () => devices?.find((d) => d.deviceId === selectedDeviceId) ?? null,
        [devices, selectedDeviceId],
    );

    // Test-only: parsed once at mount so a query-string change requires a
    // reload to take effect (no live re-evaluation of the flag while a
    // session is in flight). Returns null in production. Cleanup: remove
    // this state + the parseFanoutFlag import + the fanout branch in the
    // slot-build effect + the SLOT_COLORS extension.
    const [fanoutConfig] = useState(() => parseFanoutFlag(window.location.search));
    const [rendererFlag] = useState(() => parseRendererFlag(window.location.search));
    // WebGPU is the production default; ?renderer=2d is the only
    // opt-out. `null` (no flag) and explicit `'webgpu'` both go
    // through the WebGPU path. Hoisted so the two PitchPlot props
    // (rendererWorkerUrl + useUnderlay) cannot diverge.
    const useWebGpu = rendererFlag !== '2d';

    const [controller] = useState(() => new PlotController(useWebGpu ? webgpuWorkerUrl : undefined));

    // Started gates audio construction on an explicit user gesture: the
    // Start button overlay on the pitch plot. Browser autoplay policy
    // (Chrome on Windows in particular) starts AudioContexts in
    // 'suspended' state when constructed without recent user activation;
    // resume() doesn't reliably help (it pends until the next gesture
    // that triggers a state change, which a no-op dropdown click is
    // not). An explicit Start click synchronously builds slots inside
    // the click's activation context, so useVoiceChannels' new
    // AudioContext starts in 'running' immediately.
    const [started, setStarted] = useState(false);

    // Slots are built in an effect (not a useMemo) so crypto.randomUUID()
    // fires exactly once per device change. useMemo's "best-effort cache"
    // contract allows React to invalidate even when deps haven't changed,
    // which would silently regenerate channelIds and desync the worker's
    // rings from the still-arriving frames. The effect runs whenever the
    // selected device changes; useVoiceChannels then tears down the old
    // channel and constructs a new one keyed on the fresh channelId.
    const [slots, setSlots] = useState<Slot[] | null>(null);
    useEffect(() => {
        if (!started || !selectedDevice) {
            setSlots(null);

            return;
        }
        if (fanoutConfig) {
            // One physical mic + N render slots. The primary slot owns
            // the audio capture (deviceId from the picker, fanoutGroup
            // primary=true); the remaining N-1 are render-only ghosts.
            // FanoutVoiceChannel internally fires N onFrameSourceReady
            // events with these channelIds, populating the registry +
            // useFrameState + plot worker just as N real channels would.
            const channelIds = Array.from(
                {length: fanoutConfig.count},
                () => crypto.randomUUID(),
            );
            setSlots(channelIds.map((channelId, i) => ({
                channelId,
                voiceLabel: `Test ${i + 1}`,
                deviceId: selectedDevice.deviceId,
                deviceLabel: `Test ${i + 1}`,
                color: SLOT_COLORS[i % SLOT_COLORS.length],
                fanoutGroup: {
                    primary: i === 0,
                    derivedChannelIds: channelIds,
                    pitchOffsetsCents: fanoutConfig.offsetsCents,
                },
            })));

            return;
        }
        setSlots([{
            channelId: crypto.randomUUID(),
            voiceLabel: 'Voice 1',
            deviceId: selectedDevice.deviceId,
            deviceLabel: selectedDevice.label,
            color: SLOT_COLORS[0],
        }]);
    }, [started, selectedDevice, fanoutConfig]);

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

    useEffect(() => {
        return registry.subscribe({
            onReady: (channelId, source, _reader) => {
                const slot = slots?.find((s) => s.channelId === channelId);
                // Default fallback to white if the slot is somehow missing.
                const color = slot?.color ?? '#ffffff';
                controller.attachVowelChannel(channelId, color, source);
            },
            onRebased: (channelId, epochOffsetMs) =>
                controller.rebaseVowelChannel(channelId, epochOffsetMs),
            onGone: (channelId) => controller.detachVowelChannel(channelId),
        });
    }, [registry, controller, slots]);

    const voices = useMemo(() => slotsToVoices(slots ?? []), [slots]);

    return (
        <main style={mainStyle}>
            <h1>Ring-O-Meter</h1>
            {/*
              * Both rows below render placeholder content (a disabled
              * <select> in DeviceSetup, an inert NoteReadout below) when
              * the live data is not yet available. The placeholders'
              * natural heights anchor the layout so the plot row stays
              * put as devices enumerate and slots populate; no
              * pixel-value minHeight reservations to guess and rot.
              */}
            <div style={{display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16}}>
                <DeviceSetup
                    devices={devicesError ? [] : devices}
                    selectedDeviceId={selectedDeviceId}
                    onSelect={setSelectedDeviceId}
                />
                {devicesError && (
                    <p style={{color: 'crimson', margin: 0}}>
                        Could not enumerate audio inputs: {devicesError.message}
                    </p>
                )}
            </div>
            <div style={{display: 'flex', gap: 16, marginBottom: 16}}>
                {slots && slots.length > 0 ? (
                    slots.map((slot) => {
                        const frame = latest[slot.channelId];

                        return (
                            <NoteReadout
                                key={slot.channelId}
                                deviceLabel={slot.deviceLabel}
                                fundamentalHz={frame?.fundamentalHz ?? 0}
                                confidence={frame?.confidence ?? 0}
                            />
                        );
                    })
                ) : (
                    // Placeholder NoteReadout while pre-Start (or no
                    // device selected yet). Renders the dim "--" digits
                    // path (fundamentalHz=0 fails shouldDisplayPitch),
                    // pinning the row's height to whatever the live
                    // readout will be. selectedDevice?.label gracefully
                    // falls back if devices haven't enumerated yet.
                    <NoteReadout
                        deviceLabel={selectedDevice?.label ?? 'Voice 1'}
                        fundamentalHz={0}
                        confidence={0}
                    />
                )}
            </div>
            <div style={{display: 'flex', gap: 16, alignItems: 'stretch', height: 360}}>
                <div style={{position: 'relative', flex: 1}}>
                    <PitchPlot
                        voices={voices}
                        windowMs={PLOT_WINDOW_MS}
                        handleRef={plotHandleRef}
                        rendererWorkerUrl={useWebGpu ? webgpuWorkerUrl : undefined}
                        useUnderlay={useWebGpu}
                        controller={controller}
                    />
                    {!started && (
                        <button
                            type="button"
                            onClick={() => setStarted(true)}
                            style={{
                                position: 'absolute',
                                inset: 0,
                                margin: 'auto',
                                width: 200,
                                height: 80,
                                fontSize: '1.5em',
                                fontWeight: 'bold',
                                color: '#eee',
                                background: '#2a5a2a',
                                border: '2px solid #4a8a4a',
                                borderRadius: 8,
                                cursor: 'pointer',
                            }}
                        >
                            Start
                        </button>
                    )}
                </div>
                <VowelPlot
                    controller={controller}
                    useUnderlay={useWebGpu}
                    style={{width: 360, flexShrink: 0}}
                />
            </div>
            <AlgorithmToggle />
        </main>
    );
}

function AlgorithmToggle() {
    const [method, setMethod] = useState<'burg' | 'autocorrelation'>(() => {
        const stored = localStorage.getItem('lpcMethod');

        return stored === 'autocorrelation' ? 'autocorrelation' : 'burg';
    });

    useEffect(() => {
        localStorage.setItem('lpcMethod', method);
        // Walk all live VoiceChannel / FanoutVoiceChannel instances and
        // forward the new method to each. The global is a temporary
        // escape hatch published by useVoiceChannels (cleanup task
        // removes both halves once the manual triage picks a winner).
        const voiceChannels = (globalThis as Record<string, unknown>)['__voiceChannels__'] as
            | Iterable<{setLpcMethod: (m: 'burg' | 'autocorrelation') => void}>
            | undefined;
        if (voiceChannels) {
            for (const vc of voiceChannels) {
                vc.setLpcMethod(method);
            }
        }
    }, [method]);

    return (
        <div style={{marginTop: 16, padding: 12, border: '1px dashed #555', borderRadius: 6}}>
            <strong>LPC algorithm (temporary triage):</strong>
            <label style={{marginLeft: 12}}>
                <input
                    type="radio"
                    name="lpcMethod"
                    checked={method === 'burg'}
                    onChange={() => setMethod('burg')}
                />
                Burg
            </label>
            <label style={{marginLeft: 8}}>
                <input
                    type="radio"
                    name="lpcMethod"
                    checked={method === 'autocorrelation'}
                    onChange={() => setMethod('autocorrelation')}
                />
                Autocorrelation (Levinson)
            </label>
        </div>
    );
}
