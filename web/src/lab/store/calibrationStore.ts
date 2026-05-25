// Browser-local IndexedDB calibration store (synthesis-lab MVP), persistence
// layer only. Database `ring-o-meter-lab`, object store `calibration-trials`
// keyed on trialId, no secondary indexes (the per-dimension fit reads a full
// in-memory getAll at single-listener volumes). The sole-writer lock,
// listenerId/sessionId minting, and the lab UI states are out of this layer.

import type {CalibrationTrial} from './calibrationTrial';
import {CALIBRATION_ROW_SCHEMA_VERSION, tryNormalizeStoredTrial} from './calibrationTrial';

export const DB_NAME = 'ring-o-meter-lab';
const STORE_NAME = 'calibration-trials';
const DB_VERSION = 1;
const EXPORT_SCHEMA_VERSION = 1;

export type CalibrationErrorKind = 'quota' | 'denied' | 'transaction' | 'version';

export class CalibrationStoreError extends Error {
    readonly kind: CalibrationErrorKind;

    constructor(kind: CalibrationErrorKind, message: string, options?: {cause?: unknown}) {
        super(message, options);
        this.name = 'CalibrationStoreError';
        this.kind = kind;
    }
}

export interface GetAllResult {
    rows: CalibrationTrial[];
    skippedMalformedCount: number;
}

export interface ExportEnvelope {
    exportSchemaVersion: number;
    exportedAtMs: number;
    rowSchemaVersion: number;
    rowCount: number;
    skippedMalformedCount: number;
    rows: CalibrationTrial[];
}

export interface CalibrationStore {
    addTrial(trial: CalibrationTrial): Promise<void>;
    getAllTrials(): Promise<GetAllResult>;
    exportToJson(): Promise<string>;
    clear(): Promise<void>;
    close(): void;
}

// Test-only widening: adds `putRaw` to inject an arbitrary record so the
// skip-and-count read path can be exercised. Production consumers depend on
// `CalibrationStore`, which has no `putRaw`; obtain this via
// `openCalibrationStoreForTest`.
export interface TestCalibrationStore extends CalibrationStore {
    putRaw(record: unknown): Promise<void>;
}

function errorName(err: unknown): string {
    if (err !== null && typeof err === 'object' && 'name' in err && typeof (err as {name: unknown}).name === 'string') {
        return (err as {name: string}).name;
    }

    return '';
}

// Open-time failures: a stale tab opening a higher-version database -> version;
// everything else (permission/private-mode/open errored, store never opened) -> denied.
export function mapOpenError(err: unknown): CalibrationStoreError {
    if (errorName(err) === 'VersionError') {
        return new CalibrationStoreError('version', 'Calibration store version conflict; reload to update.', {cause: err});
    }

    return new CalibrationStoreError('denied', 'Calibration store could not be opened.', {cause: err});
}

// Transaction-time failures (write, read, or clear): a quota-exceeded abort ->
// quota; any other transaction failure (including a connection force-closed
// mid-session) -> transaction. A read-only transaction cannot raise quota, so
// it falls through to transaction.
export function mapTransactionError(err: unknown): CalibrationStoreError {
    if (errorName(err) === 'QuotaExceededError') {
        return new CalibrationStoreError('quota', 'Calibration storage quota exceeded.', {cause: err});
    }

    return new CalibrationStoreError('transaction', 'Calibration store transaction failed.', {cause: err});
}

function writeRecord(db: IDBDatabase, record: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
            tx = db.transaction(STORE_NAME, 'readwrite');
        } catch (err) {
            reject(mapTransactionError(err));

            return;
        }

        const request = tx.objectStore(STORE_NAME).add(record);
        request.onerror = () => reject(mapTransactionError(request.error));
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(mapTransactionError(tx.error));
    });
}

function readAll(db: IDBDatabase): Promise<GetAllResult> {
    return new Promise<GetAllResult>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
            tx = db.transaction(STORE_NAME, 'readonly');
        } catch (err) {
            reject(mapTransactionError(err));

            return;
        }

        const request = tx.objectStore(STORE_NAME).getAll();
        request.onerror = () => reject(mapTransactionError(request.error));
        tx.onabort = () => reject(mapTransactionError(tx.error));
        request.onsuccess = () => {
            const rows: CalibrationTrial[] = [];
            let skippedMalformedCount = 0;
            for (const raw of request.result as unknown[]) {
                const normalized = tryNormalizeStoredTrial(raw);
                if (normalized === null) {
                    skippedMalformedCount += 1;
                } else {
                    rows.push(normalized);
                }
            }

            resolve({rows, skippedMalformedCount});
        };
    });
}

function clearStore(db: IDBDatabase): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
            tx = db.transaction(STORE_NAME, 'readwrite');
        } catch (err) {
            reject(mapTransactionError(err));

            return;
        }

        const request = tx.objectStore(STORE_NAME).clear();
        request.onerror = () => reject(mapTransactionError(request.error));
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(mapTransactionError(tx.error));
    });
}

async function exportToJson(db: IDBDatabase): Promise<string> {
    const {rows, skippedMalformedCount} = await readAll(db);
    const envelope: ExportEnvelope = {
        exportSchemaVersion: EXPORT_SCHEMA_VERSION,
        exportedAtMs: Date.now(),
        // The exporting build's current constant, not a per-row aggregate. Each
        // row carries its own rowSchemaVersion; consumers read that per row for
        // mixed-version stores after a future bump (all rows are v1 today).
        rowSchemaVersion: CALIBRATION_ROW_SCHEMA_VERSION,
        rowCount: rows.length,
        skippedMalformedCount,
        rows,
    };

    return JSON.stringify(envelope, null, 2);
}

function createStore(db: IDBDatabase): TestCalibrationStore {
    return {
        addTrial: (trial) => writeRecord(db, trial),
        getAllTrials: () => readAll(db),
        exportToJson: () => exportToJson(db),
        clear: () => clearStore(db),
        putRaw: (record) => writeRecord(db, record),
        close: () => db.close(),
    };
}

function openInternal(factory: IDBFactory): Promise<TestCalibrationStore> {
    return new Promise<TestCalibrationStore>((resolve, reject) => {
        if (!factory) {
            reject(new CalibrationStoreError('denied', 'IndexedDB is not available in this environment.'));

            return;
        }

        let request: IDBOpenDBRequest;
        try {
            request = factory.open(DB_NAME, DB_VERSION);
        } catch (err) {
            reject(mapOpenError(err));

            return;
        }

        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, {keyPath: 'trialId'});
            }
        };
        request.onsuccess = () => resolve(createStore(request.result));
        request.onerror = () => reject(mapOpenError(request.error));
    });
}

export function openCalibrationStore(factory: IDBFactory = globalThis.indexedDB): Promise<CalibrationStore> {
    return openInternal(factory);
}

// Test-only: returns the store widened with `putRaw` for malformed-row injection.
export function openCalibrationStoreForTest(factory: IDBFactory = globalThis.indexedDB): Promise<TestCalibrationStore> {
    return openInternal(factory);
}
