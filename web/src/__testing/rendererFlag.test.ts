import {describe, expect, test, vi} from 'vitest';
import {parseRendererFlag} from './rendererFlag';

describe('parseRendererFlag', () => {
    test('returns null for empty search', () => {
        expect(parseRendererFlag('')).toBeNull();
    });

    test('returns null when renderer param is absent', () => {
        expect(parseRendererFlag('?fanout=4')).toBeNull();
    });

    test('returns "webgpu" for ?renderer=webgpu', () => {
        expect(parseRendererFlag('?renderer=webgpu')).toBe('webgpu');
    });

    test('returns null and warns for unrecognised renderer values', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(parseRendererFlag('?renderer=metal')).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });

    test('returns null and warns for empty renderer value', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(parseRendererFlag('?renderer=')).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });
});
