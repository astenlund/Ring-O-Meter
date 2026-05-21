import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {parseFanoutFlag} from './fanoutFlag';

describe('parseFanoutFlag', () => {
    beforeEach(() => {
        // Suppress the parser's console.warn in tests that exercise
        // invalid-input paths; restored after each test via restoreAllMocks.
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns null when ?fanout is absent (production path)', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?other=thing');

        // Assert
        expect(result).toBeNull();
    });

    it('treats bare ?fanout as the canonical dom7 quartet', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout', true);

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 386, 702, 969]});
    });

    it('treats ?fanout= (empty value) as the canonical dom7 quartet', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=', true);

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 386, 702, 969]});
    });

    it('defaults ?fanout=4 to JI dom7 offsets', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4', true);

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 386, 702, 969]});
    });

    it('defaults ?fanout=N (N != 4) to the 8-cent step pattern', () => {
        // Arrange + Act
        const two = parseFanoutFlag('?fanout=2', true);
        const eight = parseFanoutFlag('?fanout=8', true);

        // Assert
        expect(two).toEqual({count: 2, offsetsCents: [0, 8]});
        expect(eight).toEqual({count: 8, offsetsCents: [0, 8, 16, 24, 32, 40, 48, 56]});
    });

    it('honours explicit offsets= over the dom7 default', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4&offsets=0,15,30,45', true);

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 15, 30, 45]});
    });

    it('pads short offsets with the step pattern, not dom7', () => {
        // Arrange + Act: caller supplied custom values, so we don't
        // fabricate dom7 for the unfilled slots.
        const result = parseFanoutFlag('?fanout=4&offsets=0,5', true);

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 5, 16, 24]});
    });

    it('truncates excess offsets to count', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4&offsets=0,5,10,15,20', true);

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 5, 10, 15]});
    });

    it('rejects non-integer counts', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4.5', true);

        // Assert
        expect(result).toBeNull();
    });

    it('rejects counts below 1', () => {
        // Arrange + Act
        const zero = parseFanoutFlag('?fanout=0', true);
        const negative = parseFanoutFlag('?fanout=-1', true);

        // Assert
        expect(zero).toBeNull();
        expect(negative).toBeNull();
    });

    it('rejects counts above the cap', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=17', true);

        // Assert
        expect(result).toBeNull();
    });

    it('rejects garbage counts', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=banana', true);

        // Assert
        expect(result).toBeNull();
    });

    it('rejects non-numeric entries in offsets=', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4&offsets=0,abc,30,45', true);

        // Assert
        expect(result).toBeNull();
    });

    it('returns null without warn when ?fanout absent and devModesEnabled false', () => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        // Act
        const result = parseFanoutFlag('?other=thing', false);

        // Assert
        expect(result).toBeNull();
        expect(warn).not.toHaveBeenCalled();
    });
});

// Isolate module to reset the warn-once latch before testing the
// devModesEnabled:false path. vi.resetModules() is required because
// _warnedAboutIgnoredFanout is module-scoped state.
describe('parseFanoutFlag - fanout ignored with devModesEnabled:false', () => {
    let parseFreshFlag: (search: string, devModesEnabled?: boolean) => import('./fanoutFlag').FanoutFlag | null;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import('./fanoutFlag');
        parseFreshFlag = mod.parseFanoutFlag;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns null and warns once when ?fanout present and devModesEnabled false', () => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        // Act
        const result = parseFreshFlag('?fanout=4', false);

        // Assert
        expect(result).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
            '[ring-o-meter] ?fanout flag ignored in this environment (devModesEnabled: false)',
        );
    });

    it('latch suppresses repeated warns on subsequent calls', () => {
        // Arrange
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        // Act: two calls with devModesEnabled false
        parseFreshFlag('?fanout=4', false);
        parseFreshFlag('?fanout=2', false);

        // Assert: warn fires on first call only
        expect(warn).toHaveBeenCalledOnce();
    });

    it('returns the flag when devModesEnabled is true', () => {
        // Arrange + Act
        const result = parseFreshFlag('?fanout=4', true);

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 386, 702, 969]});
    });
});
