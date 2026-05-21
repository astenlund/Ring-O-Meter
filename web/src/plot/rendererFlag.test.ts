import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
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

    test('returns "2d" for ?renderer=2d', () => {
        expect(parseRendererFlag('?renderer=2d')).toBe('2d');
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

    test('?renderer=2d works regardless of devModesEnabled', () => {
        expect(parseRendererFlag('?renderer=2d', false)).toBe('2d');
        expect(parseRendererFlag('?renderer=2d', true)).toBe('2d');
    });

    test('?renderer=webgpu works regardless of devModesEnabled', () => {
        expect(parseRendererFlag('?renderer=webgpu', false)).toBe('webgpu');
        expect(parseRendererFlag('?renderer=webgpu', true)).toBe('webgpu');
    });

    test('?renderer=trace + devModesEnabled:true returns "trace"', () => {
        expect(parseRendererFlag('?renderer=trace', true)).toBe('trace');
    });
});

// Isolate module to reset the warn-once latch before testing the
// devModesEnabled:false path. vi.resetModules() is required because
// _warnedAboutIgnoredRenderer is module-scoped state.
describe('parseRendererFlag - trace ignored with devModesEnabled:false', () => {
    let parseFreshFlag: (search: string, devModesEnabled?: boolean) => string | null;

    beforeEach(async () => {
        vi.resetModules();
        const mod = await import('./rendererFlag');
        parseFreshFlag = mod.parseRendererFlag;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('?renderer=trace + devModesEnabled:false returns null and warns once', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        expect(parseFreshFlag('?renderer=trace', false)).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
            '[ring-o-meter] ?renderer=trace ignored in this environment (devModesEnabled: false)',
        );

        // Second call: latch prevents a second warn.
        expect(parseFreshFlag('?renderer=trace', false)).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
    });
});
