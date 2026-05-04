import {beforeEach, describe, expect, it, vi} from 'vitest';

import {parseFanoutFlag} from './fanoutFlag';

describe('parseFanoutFlag', () => {
    beforeEach(() => {
        // Suppress the parser's console.warn in tests that exercise
        // invalid-input paths; restored automatically by vitest between
        // tests via vi.spyOn.
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    it('returns null when ?fanout is absent (production path)', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?other=thing');

        // Assert
        expect(result).toBeNull();
    });

    it('treats bare ?fanout as the canonical dom7 quartet', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout');

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 386, 702, 969]});
    });

    it('treats ?fanout= (empty value) as the canonical dom7 quartet', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=');

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 386, 702, 969]});
    });

    it('defaults ?fanout=4 to JI dom7 offsets', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4');

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 386, 702, 969]});
    });

    it('defaults ?fanout=N (N != 4) to the 8-cent step pattern', () => {
        // Arrange + Act
        const two = parseFanoutFlag('?fanout=2');
        const eight = parseFanoutFlag('?fanout=8');

        // Assert
        expect(two).toEqual({count: 2, offsetsCents: [0, 8]});
        expect(eight).toEqual({count: 8, offsetsCents: [0, 8, 16, 24, 32, 40, 48, 56]});
    });

    it('honours explicit offsets= over the dom7 default', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4&offsets=0,15,30,45');

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 15, 30, 45]});
    });

    it('pads short offsets with the step pattern, not dom7', () => {
        // Arrange + Act: caller supplied custom values, so we don't
        // fabricate dom7 for the unfilled slots.
        const result = parseFanoutFlag('?fanout=4&offsets=0,5');

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 5, 16, 24]});
    });

    it('truncates excess offsets to count', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4&offsets=0,5,10,15,20');

        // Assert
        expect(result).toEqual({count: 4, offsetsCents: [0, 5, 10, 15]});
    });

    it('rejects non-integer counts', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4.5');

        // Assert
        expect(result).toBeNull();
    });

    it('rejects counts below 1', () => {
        // Arrange + Act
        const zero = parseFanoutFlag('?fanout=0');
        const negative = parseFanoutFlag('?fanout=-1');

        // Assert
        expect(zero).toBeNull();
        expect(negative).toBeNull();
    });

    it('rejects counts above the cap', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=17');

        // Assert
        expect(result).toBeNull();
    });

    it('rejects garbage counts', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=banana');

        // Assert
        expect(result).toBeNull();
    });

    it('rejects non-numeric entries in offsets=', () => {
        // Arrange + Act
        const result = parseFanoutFlag('?fanout=4&offsets=0,abc,30,45');

        // Assert
        expect(result).toBeNull();
    });
});
