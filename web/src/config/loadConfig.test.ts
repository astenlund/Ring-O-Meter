import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {loadConfig} from './loadConfig';

describe('loadConfig', () => {
    beforeEach(() => vi.restoreAllMocks());
    afterEach(() => vi.restoreAllMocks());

    it('returns devModesEnabled true when server says true', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({hubUrl: '', devModesEnabled: true}),
            {status: 200, headers: {'content-type': 'application/json'}},
        )));

        const cfg = await loadConfig();

        expect(cfg).toEqual({hubUrl: '', devModesEnabled: true});
    });

    it('defaults to fail-closed on network error after one retry', async () => {
        const fetcher = vi.fn(async () => { throw new Error('network'); });
        vi.stubGlobal('fetch', fetcher);

        const cfg = await loadConfig({retryDelayMs: 0});

        expect(cfg).toEqual({hubUrl: '', devModesEnabled: false});
        expect(fetcher).toHaveBeenCalledTimes(2); // one + one retry
    });

    it('defaults to fail-closed on JSON parse failure', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('garbage', {status: 200})));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const cfg = await loadConfig({retryDelayMs: 0});

        expect(cfg.devModesEnabled).toBe(false);
        expect(warn).toHaveBeenCalled();
    });

    it('rejects non-boolean devModesEnabled fail-closed with warn', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({hubUrl: '', devModesEnabled: 'true'}),
            {status: 200, headers: {'content-type': 'application/json'}},
        )));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const cfg = await loadConfig({retryDelayMs: 0});

        expect(cfg.devModesEnabled).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("'devModesEnabled'"));
    });

    it('treats missing devModesEnabled as false without warning', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(
            JSON.stringify({hubUrl: ''}),
            {status: 200, headers: {'content-type': 'application/json'}},
        )));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const cfg = await loadConfig({retryDelayMs: 0});

        expect(cfg.devModesEnabled).toBe(false);
        expect(warn).not.toHaveBeenCalled();
    });
});
