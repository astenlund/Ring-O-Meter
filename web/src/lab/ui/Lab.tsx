// web/src/lab/ui/Lab.tsx
// The /lab orchestrator. Owns the store handle, listener identity, writer lock,
// AudioContext, the calibration session, and the error/lifecycle state machine;
// builds per-trial audio (renderChord x2 -> seamless loop x2 -> LabAudioPlayer) and
// records choices. Store + audio factories are injected (production defaults below)
// so the state machine is testable with fakes. See spec "## Lab UI surface".

import {type CSSProperties, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {renderChord} from '../synth/chordSynth';
import {openCalibrationSession, type CalibrationSession} from '../protocol/calibrationSession';
import {CalibrationConfigError, ResampleExhaustedError, type PendingTrial, type Pick, type SessionConfig} from '../protocol/protocolTypes';
import {openCalibrationStore, CalibrationStoreError, type CalibrationStore, type CalibrationErrorKind} from '../store/calibrationStore';
import {computeCalibration, type CoefficientResult} from '../fit/coefficients';
import {LabAudioPlayer, type AbSide} from './labAudioPlayer';
import {makeSeamlessLoopBuffer} from './seamlessLoop';
import {useListenerId} from './useListenerId';
import {useWriterLock} from './useWriterLock';
import {StatusStrip} from './StatusStrip';
import {SessionConfigBand} from './SessionConfigBand';
import {TrialPlayerBand, type AudioController, type PlayerPhase} from './TrialPlayerBand';
import {CoefficientDashboard} from './CoefficientDashboard';
import {StoreAdminRow} from './StoreAdminRow';
import {downloadJson} from './downloadJson';

const RENDER_DURATION_S = 1.7;
const LOOP_START_S = 0.1;
const LOOP_END_S = 1.5;
const LOOP_CROSSFADE_S = 0.02;

const pageStyle: CSSProperties = {padding: 24, fontFamily: 'sans-serif', color: '#eee', background: '#181818', minHeight: '100vh'};

interface AudioHandle extends AudioController {
    dispose(): void;
}

export interface LabProps {
    openStore?: () => Promise<CalibrationStore>;
    // Constructs the AudioContext inside the Start gesture. Injected so the
    // orchestrator's state machine is testable in jsdom (which has no Web Audio).
    createAudioContext?: () => AudioContext;
    // Builds the looping A/B audio for a pending trial. Production impl renders both
    // chords offline, bakes seamless loops, and wires a LabAudioPlayer.
    createAudio?: (ctx: AudioContext, pending: PendingTrial) => Promise<AudioHandle>;
}

type StorageError = {kind: CalibrationErrorKind; pending: PendingTrial | null; pick: Pick | null} | null;

async function defaultCreateAudio(ctx: AudioContext, pending: PendingTrial): Promise<AudioHandle> {
    const [bufA, bufB] = await Promise.all([
        renderChord(pending.chordA, pending.seedA, RENDER_DURATION_S, ctx.sampleRate),
        renderChord(pending.chordB, pending.seedB, RENDER_DURATION_S, ctx.sampleRate),
    ]);
    const loopA = makeSeamlessLoopBuffer(bufA, LOOP_START_S, LOOP_END_S, LOOP_CROSSFADE_S);
    const loopB = makeSeamlessLoopBuffer(bufB, LOOP_START_S, LOOP_END_S, LOOP_CROSSFADE_S);
    const player = new LabAudioPlayer(ctx, loopA, loopB);

    return {
        play: () => player.play(),
        pause: () => player.pause(),
        setActive: (s: AbSide) => player.setActive(s),
        dispose: () => player.dispose(),
    };
}

export function Lab(props: LabProps) {
    const openStore = props.openStore ?? openCalibrationStore;
    const createAudioContext = props.createAudioContext ?? (() => new AudioContext());
    const createAudio = props.createAudio ?? defaultCreateAudio;

    const {listenerId, ephemeral, reset} = useListenerId();
    const lock = useWriterLock();

    const [store, setStore] = useState<CalibrationStore | null>(null);
    const [storageError, setStorageError] = useState<StorageError>(null);
    const [readError, setReadError] = useState<{kind: CalibrationErrorKind; context: 'refit' | 'export'} | null>(null);
    const [session, setSession] = useState<CalibrationSession | null>(null);
    const [pending, setPending] = useState<PendingTrial | null>(null);
    const [terminal, setTerminal] = useState<'sweep-complete' | 'resample-exhausted' | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [adminBusy, setAdminBusy] = useState(false);
    const [coefficients, setCoefficients] = useState<Map<string, CoefficientResult>>(new Map());
    const [skipped, setSkipped] = useState(0);
    const [audioUnavailable, setAudioUnavailable] = useState(false);
    // The audio handle is held in BOTH state (so the player re-renders with the live
    // controller when a new trial loads) and a ref (for imperative dispose).
    const [audioHandle, setAudioHandle] = useState<AudioHandle | null>(null);

    const ctxRef = useRef<AudioContext | null>(null);
    const audioRef = useRef<AudioHandle | null>(null);
    const configError = useRef<string | null>(null);

    // Open the store once on mount; route an open failure by kind.
    useEffect(() => {
        let cancelled = false;
        openStore().then(
            (s) => { if (!cancelled) { setStore(s); } },
            (err) => { if (!cancelled && err instanceof CalibrationStoreError) { setStorageError({kind: err.kind, pending: null, pick: null}); } },
        );

        return () => { cancelled = true; };
    }, [openStore]);

    const refit = useCallback(async (s: CalibrationStore) => {
        try {
            const {coefficients: c, skippedMalformedCount} = await computeCalibration(s);
            setCoefficients(c);
            setSkipped(skippedMalformedCount);
            setReadError((prev) => (prev?.context === 'refit' ? null : prev));
        } catch (err) {
            // Read-only failure is non-blocking: keep the last good dashboard render
            // behind a kind-keyed "couldn't refresh" notice with a retry.
            if (err instanceof CalibrationStoreError) {
                setReadError({kind: err.kind, context: 'refit'});
            }
        }
    }, []);

    useEffect(() => { if (store) { void refit(store); } }, [store, refit]);

    const advance = useCallback(async (sess: CalibrationSession) => {
        try {
            const next = sess.nextTrial();
            if (next === null) {
                setPending(null);
                setTerminal('sweep-complete');

                return;
            }
            setTerminal(null);
            setPending(next);
            // Build audio for the new trial. Store the handle in BOTH the ref (for
            // imperative dispose) and state (so the player re-renders with the live
            // controller; a ref mutation alone would not trigger that re-render).
            if (ctxRef.current) {
                audioRef.current?.dispose();
                const handle = await createAudio(ctxRef.current, next);
                audioRef.current = handle;
                setAudioHandle(handle);
            }
        } catch (err) {
            if (err instanceof ResampleExhaustedError) {
                setPending(null);
                setTerminal('resample-exhausted');
            } else {
                throw err;
            }
        }
    }, [createAudio]);

    const handleStart = useCallback(async (config: SessionConfig) => {
        if (!store) {
            return;
        }
        configError.current = null;
        // Create/resume the AudioContext inside this user-gesture handler.
        if (!ctxRef.current) {
            ctxRef.current = createAudioContext();
        }
        if (ctxRef.current.state === 'suspended') {
            await ctxRef.current.resume();
        }
        setAudioUnavailable(ctxRef.current.state !== 'running');
        try {
            const sess = openCalibrationSession(store, config);
            setSession(sess);
            await advance(sess);
        } catch (err) {
            if (err instanceof CalibrationConfigError) {
                configError.current = err.message;
                setSession(null);
            } else {
                throw err;
            }
        }
    }, [store, advance, createAudioContext]);

    // Records one decision. On a write failure, quota/transaction retain the choice
    // AND its pick for a Retry; denied/version discard it. Split out from handleChoose
    // so the Retry button replays the exact held pick rather than a guessed default.
    const recordPending = useCallback(async (p: PendingTrial, pick: Pick) => {
        if (!session || !store) {
            return;
        }
        setSubmitting(true);
        try {
            await session.recordChoice(p, pick);
            setStorageError(null);
            await refit(store);
            await advance(session);
        } catch (err) {
            if (err instanceof CalibrationStoreError) {
                const keep = err.kind === 'quota' || err.kind === 'transaction';
                setStorageError({kind: err.kind, pending: keep ? p : null, pick: keep ? pick : null});
            } else {
                throw err;
            }
        } finally {
            setSubmitting(false);
        }
    }, [session, store, refit, advance]);

    const handleChoose = useCallback((pick: Pick) => {
        if (!pending || submitting) {
            return;
        }
        void recordPending(pending, pick);
    }, [pending, submitting, recordPending]);

    const handleExport = useCallback(async () => {
        if (!store) {
            return;
        }
        setAdminBusy(true);
        try {
            const json = await store.exportToJson();
            downloadJson(json, `calibration-${Date.now()}.json`);
            setReadError((prev) => (prev?.context === 'export' ? null : prev));
        } catch (err) {
            // Export is a READ; a failure is non-blocking (recording continues) and
            // surfaces as the kind-keyed notice, not the recording-disabled state.
            if (err instanceof CalibrationStoreError) {
                setReadError({kind: err.kind, context: 'export'});
            }
        } finally {
            setAdminBusy(false);
        }
    }, [store]);

    const handleClearAll = useCallback(async () => {
        if (!store) {
            return;
        }
        setAdminBusy(true);
        try {
            await store.clear();
            // A successful clear is the quota-recovery exit and clears prior read/export errors.
            setStorageError(null);
            setReadError(null);
            await refit(store);
        } catch (err) {
            // Clear is a destructive WRITE; a failure routes to the blocking state.
            if (err instanceof CalibrationStoreError) {
                setStorageError({kind: err.kind, pending: storageError?.pending ?? null, pick: storageError?.pick ?? null});
            }
        } finally {
            setAdminBusy(false);
        }
    }, [store, refit, storageError]);

    const resumeAudio = useCallback(async () => {
        if (ctxRef.current && ctxRef.current.state === 'suspended') {
            await ctxRef.current.resume();
        }
        setAudioUnavailable(!ctxRef.current || ctxRef.current.state !== 'running');
    }, []);

    // Dispose audio on unmount.
    useEffect(() => () => {
        audioRef.current?.dispose();
        void ctxRef.current?.close();
    }, []);

    const phase: PlayerPhase = useMemo(() => {
        // Terminals take precedence over audio-unavailable: once a sweep is done there
        // is no trial to gate, so a later context-suspend must not mask completion.
        if (terminal === 'sweep-complete') {
            return {kind: 'sweep-complete'};
        }
        if (terminal === 'resample-exhausted') {
            return {kind: 'resample-exhausted'};
        }
        if (audioUnavailable) {
            return {kind: 'audio-unavailable', onResume: () => { void resumeAudio(); }};
        }
        if (pending) {
            return {kind: 'trial', pending};
        }

        return {kind: 'sweep-complete'};
    }, [audioUnavailable, terminal, pending, resumeAudio]);

    const sessionActive = session !== null && terminal === null && pending !== null;

    return (
        <main style={pageStyle}>
            <h1>Ring-O-Meter Lab</h1>
            <StatusStrip
                listenerId={listenerId}
                listenerEphemeral={ephemeral}
                lock={lock.state}
                storage={storageError ? 'unavailable' : 'ok'}
                onResetListener={reset}
                resetDisabled={sessionActive}
            />
            {storageError && (
                <div style={{padding: 12, background: '#3a1a1a', borderRadius: 8, marginBottom: 16}} data-testid="storage-error">
                    <p style={{color: 'crimson'}}>Storage error ({storageError.kind}). {storageError.kind === 'version' ? 'Reload to update.' : 'Recording is disabled until resolved.'}</p>
                    {storageError.kind === 'quota' && <p>Export then Clear all to recover (export is a backup; clear frees quota).</p>}
                    {storageError.pending && storageError.pick && (storageError.kind === 'quota' || storageError.kind === 'transaction') && (
                        <button type="button" data-testid="retry-save" disabled={submitting} onClick={() => { void recordPending(storageError.pending!, storageError.pick!); }}>Retry save</button>
                    )}
                </div>
            )}
            {readError && (
                <div style={{padding: 8, background: '#2a2a1a', borderRadius: 8, marginBottom: 16}} data-testid="read-error">
                    <span style={{color: '#e0a030'}}>Couldn't {readError.context === 'export' ? 'export' : 'refresh'} ({readError.kind}); recording continues. </span>
                    <button type="button" data-testid="read-retry" onClick={() => { if (readError.context === 'export') { void handleExport(); } else if (store) { void refit(store); } }}>Retry</button>
                </div>
            )}
            {!session && (
                <>
                    {configError.current && <p style={{color: 'crimson'}} data-testid="config-error">{configError.current}</p>}
                    <SessionConfigBand listenerId={listenerId} disabled={store === null || storageError !== null} onStart={(c) => { void handleStart(c); }} />
                </>
            )}
            {session && <TrialPlayerBand phase={phase} submitting={submitting} onChoose={handleChoose} audio={audioHandle ?? undefined} onAudioUnavailable={() => setAudioUnavailable(true)} />}
            {session && (terminal !== null) && (
                <button type="button" data-testid="reconfigure" onClick={() => { setSession(null); setPending(null); setTerminal(null); audioRef.current?.dispose(); audioRef.current = null; setAudioHandle(null); }}>Reconfigure</button>
            )}
            <CoefficientDashboard coefficients={coefficients} skippedMalformedCount={skipped} onRefresh={() => { if (store) { void refit(store); } }} />
            <StoreAdminRow onExport={() => { void handleExport(); }} onClearAll={() => { void handleClearAll(); }} busy={adminBusy || submitting} />
        </main>
    );
}

export default Lab;
