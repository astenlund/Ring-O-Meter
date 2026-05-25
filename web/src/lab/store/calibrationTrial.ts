// Row types and helpers for the calibration store (synthesis-lab MVP). The row
// envelope and the synthesis-parameter payload version independently:
// CALIBRATION_ROW_SCHEMA_VERSION gates row-envelope read tolerance,
// PARAMS_SCHEMA_VERSION gates the embedded chord-snapshot shape. sweepAxis /
// sweepDelta are persisted as opaque values; their canonical namespace is the
// trial-generation layer's concern, not this layer's.

import type {ChordParams} from '../synth/voiceParams';
import {PARTIAL_COUNT} from '../synth/voiceParams';

export const CALIBRATION_ROW_SCHEMA_VERSION = 1;
export const PARAMS_SCHEMA_VERSION = 1;

export type SelectorMode = 'sweep' | 'random';
export type TrialChoice = 'A' | 'B' | 'tie';

export interface ParamsSnapshot {
    paramsSchemaVersion: number;
    chord: ChordParams;
}

export interface CalibrationTrial {
    rowSchemaVersion: number;
    trialId: string;
    sessionId: string;
    listenerId: string;
    selectorMode: SelectorMode;
    sweepAxis: string | null;
    sweepDelta: number | null;
    paramsA: ParamsSnapshot;
    paramsB: ParamsSnapshot;
    seedA: number;
    seedB: number;
    choice: TrialChoice;
    timestampMs: number;
    isSanityTrial: boolean;
}

// Caller-supplied fields for a new trial. The store stamps rowSchemaVersion;
// trialId and timestampMs are minted by the caller at choice-record time.
export interface NewTrialInput {
    trialId: string;
    sessionId: string;
    listenerId: string;
    selectorMode: SelectorMode;
    sweepAxis: string | null;
    sweepDelta: number | null;
    chordA: ChordParams;
    chordB: ChordParams;
    seedA: number;
    seedB: number;
    choice: TrialChoice;
    timestampMs: number;
    isSanityTrial?: boolean;
}

// Stores the chord by reference (no defensive copy); IndexedDB structured-clones
// on write, so a persisted row is decoupled from the live object.
export function snapshotChord(chord: ChordParams): ParamsSnapshot {
    return {paramsSchemaVersion: PARAMS_SCHEMA_VERSION, chord};
}

// Validates a stored snapshot and returns its chord. Throws a plain Error on an
// unsupported paramsSchemaVersion or a structurally malformed snapshot; callers
// re-rendering a stored trial must catch.
export function reloadChord(snapshot: ParamsSnapshot): ChordParams {
    if (snapshot.paramsSchemaVersion !== PARAMS_SCHEMA_VERSION) {
        throw new Error(`Unsupported paramsSchemaVersion ${snapshot.paramsSchemaVersion}; expected ${PARAMS_SCHEMA_VERSION}.`);
    }

    if (!Array.isArray(snapshot.chord?.voices) || snapshot.chord.voices.length === 0) {
        throw new Error('Params snapshot has no voices.');
    }

    for (const voice of snapshot.chord.voices) {
        const partials = voice?.partialAmplitudes;
        if (!Array.isArray(partials) || partials.length !== PARTIAL_COUNT) {
            throw new Error(`Voice partialAmplitudes is not an array of length ${PARTIAL_COUNT}.`);
        }
    }

    return snapshot.chord;
}

export function makeCalibrationTrial(input: NewTrialInput): CalibrationTrial {
    return {
        rowSchemaVersion: CALIBRATION_ROW_SCHEMA_VERSION,
        trialId: input.trialId,
        sessionId: input.sessionId,
        listenerId: input.listenerId,
        selectorMode: input.selectorMode,
        sweepAxis: input.sweepAxis,
        sweepDelta: input.sweepDelta,
        paramsA: snapshotChord(input.chordA),
        paramsB: snapshotChord(input.chordB),
        seedA: input.seedA,
        seedB: input.seedB,
        choice: input.choice,
        timestampMs: input.timestampMs,
        isSanityTrial: input.isSanityTrial ?? false,
    };
}

function isParamsSnapshot(value: unknown): value is ParamsSnapshot {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    const snap = value as Record<string, unknown>;
    if (typeof snap.paramsSchemaVersion !== 'number') {
        return false;
    }

    try {
        reloadChord(snap as unknown as ParamsSnapshot);

        return true;
    } catch {
        // Malformed or unsupported-version snapshot; treated as a malformed row.

        return false;
    }
}

// Read-side coercion. Returns a normalized CalibrationTrial, applying the
// documented historical defaults for optional columns (rowSchemaVersion -> 1,
// isSanityTrial -> false, sweepAxis/sweepDelta -> null). Returns null when a
// required column is absent/mistyped or a params snapshot is malformed, so the
// reader can skip-and-count rather than throw on one bad row.
export function tryNormalizeStoredTrial(raw: unknown): CalibrationTrial | null {
    if (raw === null || typeof raw !== 'object') {
        return null;
    }

    const r = raw as Record<string, unknown>;

    const requiredStrings = ['trialId', 'sessionId', 'listenerId'] as const;
    for (const key of requiredStrings) {
        if (typeof r[key] !== 'string') {
            return null;
        }
    }

    if (r.selectorMode !== 'sweep' && r.selectorMode !== 'random') {
        return null;
    }

    if (r.choice !== 'A' && r.choice !== 'B' && r.choice !== 'tie') {
        return null;
    }

    if (typeof r.seedA !== 'number' || typeof r.seedB !== 'number' || typeof r.timestampMs !== 'number') {
        return null;
    }

    if (!isParamsSnapshot(r.paramsA) || !isParamsSnapshot(r.paramsB)) {
        return null;
    }

    const sweepAxis = typeof r.sweepAxis === 'string' ? r.sweepAxis : null;
    const sweepDelta = typeof r.sweepDelta === 'number' ? r.sweepDelta : null;

    return {
        rowSchemaVersion: typeof r.rowSchemaVersion === 'number' ? r.rowSchemaVersion : 1,
        trialId: r.trialId as string,
        sessionId: r.sessionId as string,
        listenerId: r.listenerId as string,
        selectorMode: r.selectorMode,
        sweepAxis,
        sweepDelta,
        paramsA: r.paramsA as ParamsSnapshot,
        paramsB: r.paramsB as ParamsSnapshot,
        seedA: r.seedA,
        seedB: r.seedB,
        choice: r.choice,
        timestampMs: r.timestampMs,
        isSanityTrial: typeof r.isSanityTrial === 'boolean' ? r.isSanityTrial : false,
    };
}
