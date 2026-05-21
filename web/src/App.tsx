import {type CSSProperties, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {DeviceSetup} from './ui/DeviceSetup';
import {NoteReadout} from './ui/NoteReadout';
import {PitchPlot, type PitchPlotHandle} from './ui/PitchPlot';
import {VowelPlot} from './ui/VowelPlot';
import {ChordAwareDisplay} from './ui/ChordAwareDisplay';
import {slotsToVoices} from './ui/rosterToVoices';
import {useFrameState} from './audio/useFrameState';
import {useInputDevices} from './audio/useInputDevices';
import {useVoiceChannels, type VoiceChannelSlot} from './audio/useVoiceChannels';
import {useChordClassification} from './audio/useChordClassification';
import {FrameSourceRegistry} from './audio/frameSourceRegistry';
import {PlotController} from './plot/plotController';
import {useLatestRef} from './ui/useLatestRef';
import {parseFanoutFlag, type FanoutFlag} from './__testing/fanoutFlag';
import {parseRendererFlag, type RendererSelection} from './plot/rendererFlag';
import type {Renderer} from './plot/renderer';
import type {RingIndicatorState} from './ui/RingIndicatorDot';
import type {ChordIdentity} from './wire/chord';
import {loadConfig, type AppConfig} from './config/loadConfig';
import {GREEN_THRESHOLD_CENTS, YELLOW_BAND_OUTER_CENTS} from './audio/ringThresholds';
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

function computeRingState(
    residualsPerVoice: ReadonlyMap<string, number>,
    lockedChord: ChordIdentity | null,
): RingIndicatorState {
    if (lockedChord === null || residualsPerVoice.size === 0) {
        return null;
    }
    let yellowCount = 0;
    for (const cents of residualsPerVoice.values()) {
        const abs = Math.abs(cents);
        if (abs > YELLOW_BAND_OUTER_CENTS) {
            return 'red';
        }
        if (abs > GREEN_THRESHOLD_CENTS) {
            yellowCount++;
        }
    }
    if (yellowCount === 0) {
        return 'green';
    }
    if (yellowCount === 1) {
        return 'yellow';
    }

    return 'red';
}

// Build the Renderer discriminated union from the parsed flag.
function rendererFromSelection(sel: RendererSelection | null): Renderer {
    if (sel === '2d') {
        return {kind: '2d'};
    }
    if (sel === 'trace') {
        // Per the plan's precommitted decision: trace reuses the WebGPU worker
        // with a traceOnly flag; both share the same workerUrl. Task 22 wires
        // the flag; for now the workerUrl is identical.
        return {kind: 'trace', workerUrl: webgpuWorkerUrl};
    }

    return {kind: 'webgpu', workerUrl: webgpuWorkerUrl};
}

export function App() {
    const {latest, registerReader, unregisterReader} = useFrameState();
    const plotHandleRef = useRef<PitchPlotHandle | null>(null);
    // One registry instance per App lifetime, fed by useVoiceChannels and
    // multicasting to subscribers — frame state (useFrameState hook),
    // plot worker (trace), vowel polygon module, and the chord classifier
    // (via useChordClassification reading the coalesced frame-state
    // output). The SignalR publish sink will subscribe through the same
    // surface when that feature lands.
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

    // Fetched once at mount. VoiceChannel construction (and ChordAwareDisplay
    // mounting) is gated on config !== null so parseFanoutFlag /
    // parseRendererFlag are always called with the real devModesEnabled value.
    // The gate is structural, not temporal: moving VoiceChannel construction
    // earlier would re-open the race.
    const [config, setConfig] = useState<AppConfig | null>(null);
    useEffect(() => {
        loadConfig().then(setConfig);
    }, []);

    // Permanent dev-mode infrastructure; gated by devModesEnabled in /config.json.
    // Parsed exactly once when config first resolves. All derived state (fanoutConfig,
    // renderer, controller) is set atomically in the same effect so a single React
    // render flush delivers all of them together. The flagsSetRef latch prevents
    // re-parsing on subsequent renders (module-scoped warn latches in the parsers
    // must fire at most once per page load).
    const flagsSetRef = useRef(false);
    const [fanoutConfig, setFanoutConfig] = useState<FanoutFlag | null>(null);

    // Renderer + controller are created once, after config resolves and the URL
    // flags are parsed with the real devModesEnabled. React state guarantees stable
    // identity across re-renders. PlotController is one-shot per lifetime
    // (transferControlToOffscreen is irrevocable).
    const [renderer, setRenderer] = useState<Renderer | null>(null);
    const [controller, setController] = useState<PlotController | null>(null);

    useEffect(() => {
        if (config === null || flagsSetRef.current) {
            return;
        }
        flagsSetRef.current = true;
        const fc = parseFanoutFlag(window.location.search, config.devModesEnabled);
        const rs = parseRendererFlag(window.location.search, config.devModesEnabled);
        const r = rendererFromSelection(rs);
        const isTrace = r.kind === 'trace';
        const ctrl = new PlotController(
            r.kind !== '2d' ? r.workerUrl : undefined,
            isTrace,
        );
        setFanoutConfig(fc);
        setRenderer(r);
        setController(ctrl);
    }, [config]);

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

    // Pitch trace is a development / diagnostics surface, not the
    // coaching view. Default hidden; toggle in the control row brings
    // it on. Forced visible whenever the trace renderer is active (the
    // ?renderer=trace dev arm whose entire purpose is rendering the
    // trace), so the toggle is suppressed in that case.
    const [showTrace, setShowTrace] = useState(false);

    // Slots are built in an effect (not a useMemo) so crypto.randomUUID()
    // fires exactly once per device change. useMemo's "best-effort cache"
    // contract allows React to invalidate even when deps haven't changed,
    // which would silently regenerate channelIds and desync the worker's
    // rings from the still-arriving frames. The effect runs whenever the
    // selected device changes; useVoiceChannels then tears down the old
    // channel and constructs a new one keyed on the fresh channelId.
    //
    // Dep is `selectedDeviceId` (the stable string), NOT `selectedDevice`
    // (the object reference). `selectedDevice` is recomputed by useMemo
    // on every `devices` array change - including unrelated device
    // changes (USB plug/unplug of a non-mic device that triggers
    // devicechange and produces a fresh `devices` array). With
    // `selectedDevice` as dep, that benign event would tear down the
    // AudioContext + worklet for no functional reason. The effect reads
    // `selectedDevice.label` via the latest memo's stable result (the
    // memo is recomputed before the effect runs each commit).
    const [slots, setSlots] = useState<Slot[] | null>(null);
    useEffect(() => {
        // Gate on config so VoiceChannel construction never races the
        // config fetch: parseFanoutFlag was called with devModesEnabled
        // from the resolved config, not the fail-closed default.
        if (!started || !selectedDevice || config === null) {
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
        // selectedDeviceId-only dep + selectedDevice read via memo:
        // see comment block above.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [started, selectedDeviceId, fanoutConfig, config]);

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

    // Mirror of the trace subscriber's ref-at-event-time pattern: read
    // slots through a ref so this effect's deps stay stable across
    // device-switches. Listing `slots` directly would tear down and
    // re-subscribe on every roster change, racing against `onReady`
    // events fired during the same React commit (the new subscriber
    // would miss the attach for the freshly-built slot).
    const slotsRef = useLatestRef(slots);
    useEffect(() => {
        if (!controller) {
            return;
        }

        return registry.subscribe({
            onReady: (channelId, source, _reader) => {
                const slot = slotsRef.current?.find((s) => s.channelId === channelId);
                // Default fallback to white if the slot is somehow missing.
                const color = slot?.color ?? '#ffffff';
                controller.attachVowelChannel(channelId, color, source);
            },
            onRebased: (channelId, epochOffsetMs) =>
                controller.rebaseVowelChannel(channelId, epochOffsetMs),
            onGone: (channelId) => controller.detachVowelChannel(channelId),
        });
    }, [registry, controller, slotsRef]);

    const voices = useMemo(() => slotsToVoices(slots ?? []), [slots]);

    // Chord classification: runs at the ~15 Hz coalesce rate. The hook
    // produces a stable locked-chord identity + per-voice residuals for
    // React rendering; the classification result is also forwarded to the
    // plot worker per coalesce frame via setChordClassification.
    const slotDescriptors = useMemo(
        () => (slots ?? []).map((s, i) => ({channelId: s.channelId, slotIndex: i})),
        [slots],
    );
    const {lockedChord, residualsPerVoice} = useChordClassification(latest, slotDescriptors);

    const ringState = computeRingState(residualsPerVoice, lockedChord);

    // Wire classifier output to the plot worker once per coalesce frame.
    // residualsPerVoice is a Map keyed by channelId; the worker uses
    // slot index (matching AttachChannel order). Map slot index by
    // iterating slotDescriptors which has the same ordering.
    // The scratch Float32Array is reused across calls per hot-path-allocation-discipline.
    const residualsScratch = useRef(new Float32Array(8));
    useEffect(() => {
        if (!controller) {
            return;
        }
        const buf = residualsScratch.current;
        buf.fill(Number.NaN);
        if (lockedChord !== null) {
            for (let i = 0; i < slotDescriptors.length; i++) {
                const {channelId} = slotDescriptors[i];
                const r = residualsPerVoice.get(channelId);
                buf[i] = r !== undefined ? r : Number.NaN;
            }
        }
        controller.setChordClassification(
            lockedChord?.type ?? null,
            lockedChord?.rootChannelId ?? null,
            lockedChord?.rootHz ?? 0,
            buf,
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [controller, lockedChord, residualsPerVoice]);

    // Chord-bars canvas: allocated on main thread, transferred to the
    // plot worker via attachChordBarsCanvas. transferControlToOffscreen is
    // one-shot per canvas element; the latch prevents a second transfer on
    // strict-mode re-mount.
    const chordBarsTransferredRef = useRef(false);
    const handleChordBarsCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
        if (!controller || !canvas || chordBarsTransferredRef.current) {
            return;
        }
        chordBarsTransferredRef.current = true;
        const offscreen = canvas.transferControlToOffscreen();
        controller.attachChordBarsCanvas(offscreen);
    }, [controller]);

    const handleChordBarsBackingChange = useCallback(
        (cssWidth: number, cssHeight: number, dpr: number) => {
            controller?.setChordBarsBacking(cssWidth, cssHeight, dpr);
        },
        [controller],
    );

    // ChordAwareDisplay voices: same shape as the slot roster, filtered to
    // what ChordAwareDisplay needs (channelId, deviceLabel, color).
    const chordDisplayVoices = useMemo(
        () => (slots ?? []).map((s) => ({
            channelId: s.channelId,
            deviceLabel: s.deviceLabel,
            color: s.color,
        })),
        [slots],
    );

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
                {!started && renderer !== null && controller !== null && (
                    <button
                        type="button"
                        onClick={() => setStarted(true)}
                        style={{
                            padding: '10px 24px',
                            fontSize: '1.05em',
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
                {renderer !== null && renderer.kind !== 'trace' && (
                    <button
                        type="button"
                        onClick={() => setShowTrace((v) => !v)}
                        style={{
                            padding: '8px 16px',
                            fontSize: '0.95em',
                            color: '#eee',
                            background: showTrace ? '#3a5a8a' : '#2a2a2a',
                            border: `2px solid ${showTrace ? '#5a8aba' : '#555'}`,
                            borderRadius: 8,
                            cursor: 'pointer',
                        }}
                    >
                        Pitch trace: {showTrace ? 'on' : 'off'}
                    </button>
                )}
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
            {renderer !== null && controller !== null ? (
                <>
                    {/*
                      * Feature row: compact VowelPlot + ChordAwareDisplay
                      * side by side. Suppressed entirely under the trace
                      * renderer dev arm whose contract is "trace only".
                      */}
                    {renderer.kind !== 'trace' && (
                        <div style={{display: 'flex', gap: 16, alignItems: 'stretch', height: 320, marginBottom: 16}}>
                            <VowelPlot
                                controller={controller}
                                renderer={renderer}
                                style={{width: 320, flexShrink: 0}}
                            />
                            <ChordAwareDisplay
                                chord={lockedChord}
                                voices={chordDisplayVoices}
                                residualsPerVoice={residualsPerVoice}
                                ringState={ringState}
                                onCanvasRef={handleChordBarsCanvasRef}
                                onBackingChange={handleChordBarsBackingChange}
                                style={{width: 320, flexShrink: 0}}
                            />
                        </div>
                    )}
                    {/*
                      * Pitch trace row: hidden by default. CSS hide via
                      * display:none rather than conditional mount because
                      * transferControlToOffscreen() is one-shot per canvas
                      * element; an unmount-then-remount cycle would try to
                      * re-attach a fresh canvas to the same shared
                      * PlotController. The wasted paint while hidden is
                      * acceptable for an off-by-default viewing mode.
                      * Forced visible under the trace renderer dev arm.
                      */}
                    <div style={{display: showTrace || renderer.kind === 'trace' ? 'block' : 'none', height: 360, marginBottom: 16}}>
                        <PitchPlot
                            voices={voices}
                            windowMs={PLOT_WINDOW_MS}
                            handleRef={plotHandleRef}
                            renderer={renderer}
                            controller={controller}
                        />
                    </div>
                </>
            ) : (
                // While config is loading, the plot surfaces are not yet
                // mounted (renderer + controller are created after config
                // resolves). This placeholder anchors the row height so
                // layout does not shift when the surfaces appear.
                <div style={{height: 320}} />
            )}
        </main>
    );
}
