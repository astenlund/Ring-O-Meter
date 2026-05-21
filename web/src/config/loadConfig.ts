// One-shot /config.json fetcher with one retry and fail-closed defaults.
// Called once at App mount. See chord-aware-display.md "Dev mode and
// gating" for the failure-mode contract.

export interface AppConfig {
    readonly hubUrl: string;
    readonly devModesEnabled: boolean;
}

const FAIL_CLOSED: AppConfig = {hubUrl: '', devModesEnabled: false};

interface LoadOptions {
    readonly retryDelayMs?: number;
}

export async function loadConfig(opts: LoadOptions = {}): Promise<AppConfig> {
    const delay = opts.retryDelayMs ?? 1000;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetch('/config.json');
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const data = await res.json();

            return parseConfig(data);
        } catch (err) {
            if (attempt === 0) {
                await wait(delay);
                continue;
            }
            console.warn('[ring-o-meter] /config.json fetch failed; defaulting to fail-closed', err);

            return FAIL_CLOSED;
        }
    }

    return FAIL_CLOSED;
}

function parseConfig(data: unknown): AppConfig {
    if (typeof data !== 'object' || data === null) {
        console.warn('[ring-o-meter] /config.json shape unexpected; defaulting to fail-closed');

        return FAIL_CLOSED;
    }
    const o = data as Record<string, unknown>;
    const hubUrl = typeof o.hubUrl === 'string' ? o.hubUrl : '';
    let devModesEnabled = false;
    if ('devModesEnabled' in o) {
        if (typeof o.devModesEnabled === 'boolean') {
            devModesEnabled = o.devModesEnabled;
        } else {
            console.warn(
                `[ring-o-meter] /config.json field 'devModesEnabled' expected boolean, got ${typeof o.devModesEnabled}; defaulting to false.`,
            );
        }
    }

    return {hubUrl, devModesEnabled};
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
