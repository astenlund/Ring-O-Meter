import {IDBFactory} from 'fake-indexeddb';
import {beforeEach, describe, expect, it} from 'vitest';
import {neutralVoiceParams, type ChordParams} from '../synth/voiceParams';
import {makeCalibrationTrial, type CalibrationTrial, type NewTrialInput} from './calibrationTrial';
import {CalibrationStoreError, mapOpenError, mapWriteError, openCalibrationStore} from './calibrationStore';

function chord(): ChordParams {
    return {voices: [neutralVoiceParams(220)]};
}

function trial(id: string): CalibrationTrial {
    const input: NewTrialInput = {
        trialId: id,
        sessionId: 's1',
        listenerId: 'l1',
        selectorMode: 'sweep',
        sweepAxis: 'pitchVariance.drift',
        sweepDelta: 10,
        chordA: chord(),
        chordB: chord(),
        seedA: 1,
        seedB: 2,
        choice: 'A',
        timestampMs: 100,
    };

    return makeCalibrationTrial(input);
}

let factory: IDBFactory;

beforeEach(() => {
    factory = new IDBFactory();
});

describe('open / add / getAll', () => {
    it('adds a trial and reads it back', async () => {
        // Arrange
        const store = await openCalibrationStore(factory);

        // Act
        await store.addTrial(trial('t1'));
        const result = await store.getAllTrials();
        store.close();

        // Assert
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].trialId).toBe('t1');
        expect(result.skippedMalformedCount).toBe(0);
    });

    it('persists rows across a reopen of the same database', async () => {
        // Arrange
        const first = await openCalibrationStore(factory);
        await first.addTrial(trial('t1'));
        first.close();

        // Act
        const second = await openCalibrationStore(factory);
        const result = await second.getAllTrials();
        second.close();

        // Assert
        expect(result.rows.map((r) => r.trialId)).toEqual(['t1']);
    });

    it('rejects a duplicate trial id as a transaction failure', async () => {
        // Arrange
        const store = await openCalibrationStore(factory);
        await store.addTrial(trial('t1'));

        // Act / Assert
        await expect(store.addTrial(trial('t1'))).rejects.toMatchObject({kind: 'transaction'});
        store.close();
    });

    it('skips a malformed row and counts it', async () => {
        // Arrange: a valid row plus an injected malformed record
        const store = await openCalibrationStore(factory);
        await store.addTrial(trial('t1'));
        await store.putRaw({trialId: 'bad', sessionId: 's1'});

        // Act
        const result = await store.getAllTrials();
        store.close();

        // Assert
        expect(result.rows.map((r) => r.trialId)).toEqual(['t1']);
        expect(result.skippedMalformedCount).toBe(1);
    });
});

describe('error mapping', () => {
    it('maps QuotaExceededError to kind quota', () => {
        // Arrange / Act
        const mapped = mapWriteError(new DOMException('full', 'QuotaExceededError'));

        // Assert
        expect(mapped).toBeInstanceOf(CalibrationStoreError);
        expect(mapped.kind).toBe('quota');
    });

    it('maps a generic write error to kind transaction', () => {
        // Arrange / Act
        const mapped = mapWriteError(new Error('boom'));

        // Assert
        expect(mapped.kind).toBe('transaction');
    });

    it('maps VersionError to kind version', () => {
        // Arrange / Act
        const mapped = mapOpenError(new DOMException('stale', 'VersionError'));

        // Assert
        expect(mapped.kind).toBe('version');
    });

    it('maps a generic open error to kind denied', () => {
        // Arrange / Act
        const mapped = mapOpenError(new DOMException('blocked', 'SecurityError'));

        // Assert
        expect(mapped.kind).toBe('denied');
    });
});

describe('open failure', () => {
    it('rejects with kind denied when the factory throws', async () => {
        // Arrange
        const denying = {
            open() {
                throw new DOMException('blocked', 'SecurityError');
            },
        } as unknown as IDBFactory;

        // Act / Assert
        await expect(openCalibrationStore(denying)).rejects.toMatchObject({kind: 'denied'});
    });

    it('rejects with kind denied when no factory is available', async () => {
        // Act / Assert
        await expect(openCalibrationStore(undefined as unknown as IDBFactory)).rejects.toMatchObject({kind: 'denied'});
    });
});

describe('exportToJson', () => {
    it('exports an empty store as an envelope with zero rows', async () => {
        // Arrange
        const store = await openCalibrationStore(factory);

        // Act
        const json = JSON.parse(await store.exportToJson());
        store.close();

        // Assert
        expect(json.exportSchemaVersion).toBe(1);
        expect(json.rowSchemaVersion).toBe(1);
        expect(json.rowCount).toBe(0);
        expect(json.skippedMalformedCount).toBe(0);
        expect(json.rows).toEqual([]);
        expect(typeof json.exportedAtMs).toBe('number');
    });

    it('exports all stored trials with reloadable params and surfaces skipped count', async () => {
        // Arrange
        const store = await openCalibrationStore(factory);
        await store.addTrial(trial('t1'));
        await store.addTrial(trial('t2'));
        await store.putRaw({trialId: 'bad', sessionId: 's1'});

        // Act
        const json = JSON.parse(await store.exportToJson());
        store.close();

        // Assert
        expect(json.rowCount).toBe(2);
        expect(json.skippedMalformedCount).toBe(1);
        expect(json.rows.map((r: {trialId: string}) => r.trialId).sort()).toEqual(['t1', 't2']);
        expect(json.rows[0].paramsA.paramsSchemaVersion).toBe(1);
    });
});

describe('clear', () => {
    it('empties the store', async () => {
        // Arrange
        const store = await openCalibrationStore(factory);
        await store.addTrial(trial('t1'));
        await store.addTrial(trial('t2'));

        // Act
        await store.clear();
        const result = await store.getAllTrials();
        store.close();

        // Assert
        expect(result.rows).toEqual([]);
        expect(result.skippedMalformedCount).toBe(0);
    });

    it('is a no-op on an already-empty store', async () => {
        // Arrange
        const store = await openCalibrationStore(factory);

        // Act / Assert
        await expect(store.clear()).resolves.toBeUndefined();
        store.close();
    });
});
