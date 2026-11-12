import {describe, it, expect} from 'vitest';
import {STORAGE_ERROR_POLICY} from './storageErrorPolicy';

describe('STORAGE_ERROR_POLICY', () => {
    it('holds the pick for Retry save only on quota and transaction failures', () => {
        // Arrange / Act / Assert
        expect(STORAGE_ERROR_POLICY.quota.retryable).toBe(true);
        expect(STORAGE_ERROR_POLICY.transaction.retryable).toBe(true);
        expect(STORAGE_ERROR_POLICY.denied.retryable).toBe(false);
        expect(STORAGE_ERROR_POLICY.version.retryable).toBe(false);
    });

    it('tells a version failure to reload and every other kind that recording is disabled', () => {
        // Arrange / Act / Assert
        expect(STORAGE_ERROR_POLICY.version.action).toBe('Reload to update.');
        expect(STORAGE_ERROR_POLICY.quota.action).toBe('Recording is disabled until resolved.');
        expect(STORAGE_ERROR_POLICY.denied.action).toBe('Recording is disabled until resolved.');
        expect(STORAGE_ERROR_POLICY.transaction.action).toBe('Recording is disabled until resolved.');
    });

    it('offers the export-then-clear recovery hint only for quota', () => {
        // Arrange / Act / Assert
        expect(STORAGE_ERROR_POLICY.quota.recoveryHint).toBe('Export then Clear all to recover (export is a backup; clear frees quota).');
        expect(STORAGE_ERROR_POLICY.denied.recoveryHint).toBeNull();
        expect(STORAGE_ERROR_POLICY.transaction.recoveryHint).toBeNull();
        expect(STORAGE_ERROR_POLICY.version.recoveryHint).toBeNull();
    });
});
