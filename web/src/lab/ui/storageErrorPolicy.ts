// Per-kind policy for the blocking storage-error state: what the banner tells the
// listener, any recovery hint, and whether the failed pick is held for Retry save.
// The `satisfies Record<CalibrationErrorKind, ...>` check makes a new error kind a
// compile error here instead of a silent fall-through in Lab.tsx's rendering.

import type {CalibrationErrorKind} from '../store/calibrationStore';

export interface StorageErrorPolicy {
    readonly action: string;
    readonly recoveryHint: string | null;
    readonly retryable: boolean;
}

const RECORDING_DISABLED = 'Recording is disabled until resolved.';

export const STORAGE_ERROR_POLICY = {
    quota: {action: RECORDING_DISABLED, recoveryHint: 'Export then Clear all to recover (export is a backup; clear frees quota).', retryable: true},
    denied: {action: RECORDING_DISABLED, recoveryHint: null, retryable: false},
    transaction: {action: RECORDING_DISABLED, recoveryHint: null, retryable: true},
    version: {action: 'Reload to update.', recoveryHint: null, retryable: false},
} as const satisfies Record<CalibrationErrorKind, StorageErrorPolicy>;
