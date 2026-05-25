// web/src/lab/ui/Lab.test.tsx
import {describe, it, expect, afterEach, vi} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {act} from 'react';
import {Lab} from './Lab';
import type {CalibrationStore, GetAllResult} from '../store/calibrationStore';
import {CalibrationStoreError} from '../store/calibrationStore';

// A fake store that counts addTrial calls; getAllTrials returns the running rows.
function fakeStore(): CalibrationStore & {added: number} {
    const state = {added: 0};

    return {
        addTrial: async () => { state.added += 1; },
        getAllTrials: async (): Promise<GetAllResult> => ({rows: [], skippedMalformedCount: 0}),
        exportToJson: async () => '{}',
        clear: async () => undefined,
        close: () => undefined,
        get added() { return state.added; },
    } as CalibrationStore & {added: number};
}

// jsdom has no Web Audio, so inject a fake running context + a noop audio handle.
const fakeCtx = () => ({state: 'running', sampleRate: 48000, resume: async () => undefined, suspend: async () => undefined, close: async () => undefined}) as unknown as AudioContext;
const noopAudio = async () => ({play: async () => true, pause: async () => undefined, setActive: () => undefined, dispose: () => undefined});

let container: HTMLDivElement;
let root: Root;

async function mount(openStore: () => Promise<CalibrationStore>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root.render(<Lab openStore={openStore} createAudioContext={fakeCtx} createAudio={noopAudio} />);
    });
}

function setValue(selector: string, value: string) {
    const el = container.querySelector(selector) as HTMLInputElement;
    flushSync(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('change', {bubbles: true}));
    });
}

// Clicks a button and drains the detached async chain (handleStart / recordPending /
// advance are fire-and-forget); the setTimeout(0) lets all immediate-resolve promises
// settle inside act so React state has flushed before assertions.
async function clickById(selector: string) {
    await act(async () => {
        (container.querySelector(selector) as HTMLButtonElement).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('Lab', () => {
    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    });

    it('renders the config band on open and no trial player before a session starts', async () => {
        // Arrange / Act
        await mount(async () => fakeStore());

        // Assert
        expect(container.querySelector('[data-testid="config-band"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="player-body"]')).toBeNull();
    });

    it('routes a denied store-open error to a recording-disabled storage state', async () => {
        // Arrange / Act
        await mount(async () => { throw new CalibrationStoreError('denied', 'no'); });

        // Assert
        expect(container.querySelector('[data-testid="storage-error"]')).not.toBeNull();
    });

    it('records a choice and advances to the next trial', async () => {
        // Arrange: the default config is a clean dom7@220 sweep of 20 trials.
        const store = fakeStore();
        await mount(async () => store);

        // Act
        await clickById('[data-testid="start-session"]');
        await clickById('[data-testid="choose-a"]');

        // Assert: one row written and still mid-sweep (player visible).
        expect(store.added).toBe(1);
        expect(container.querySelector('[data-testid="player-body"]')).not.toBeNull();
    });

    it('reaches the sweep-complete state when the sweep is exhausted', async () => {
        // Arrange: a one-trial sweep (1 delta x 1 repeat).
        const store = fakeStore();
        await mount(async () => store);
        setValue('[data-testid="deltas-input"]', '10');
        setValue('[data-testid="repeats-input"]', '1');

        // Act
        await clickById('[data-testid="start-session"]');
        await clickById('[data-testid="choose-a"]');

        // Assert
        expect(container.querySelector('[data-testid="sweep-complete"]')).not.toBeNull();
    });
});
