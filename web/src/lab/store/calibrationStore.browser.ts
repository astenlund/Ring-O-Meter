import {afterEach, describe, expect, it} from 'vitest';
import {neutralVoiceParams, type ChordParams} from '../synth/voiceParams';
import {makeCalibrationTrial} from './calibrationTrial';
import {openCalibrationStore} from './calibrationStore';

function chord(): ChordParams {
    return {voices: [neutralVoiceParams(220)]};
}

afterEach(async () => {
    // Real IndexedDB persists across tests; delete so each run starts clean.
    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('ring-o-meter-lab');
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
    });
});

describe('calibration store against real IndexedDB', () => {
    it('persists a trial across a reopen and clears it', async () => {
        // Arrange
        const first = await openCalibrationStore();
        await first.addTrial(makeCalibrationTrial({
            trialId: 't1',
            sessionId: 's1',
            listenerId: 'l1',
            selectorMode: 'sweep',
            sweepAxis: 'pitchVariance.drift',
            sweepDelta: 8,
            chordA: chord(),
            chordB: chord(),
            seedA: 1,
            seedB: 2,
            choice: 'A',
            timestampMs: 1,
        }));
        first.close();

        // Act
        const second = await openCalibrationStore();
        const afterReopen = await second.getAllTrials();
        await second.clear();
        const afterClear = await second.getAllTrials();
        second.close();

        // Assert
        expect(afterReopen.rows).toHaveLength(1);
        expect(afterReopen.rows[0].trialId).toBe('t1');
        expect(afterClear.rows).toEqual([]);
    });
});
