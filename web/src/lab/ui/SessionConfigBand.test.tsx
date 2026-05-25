// web/src/lab/ui/SessionConfigBand.test.tsx
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {SessionConfigBand} from './SessionConfigBand';
import type {SessionConfig} from '../protocol/protocolTypes';

let container: HTMLDivElement;
let root: Root;

function render(onStart: (config: SessionConfig) => void) {
    flushSync(() => root.render(<SessionConfigBand listenerId="listener-1" disabled={false} onStart={onStart} />));
}

function setValue(selector: string, value: string) {
    const el = container.querySelector(selector) as HTMLInputElement | HTMLSelectElement;
    flushSync(() => {
        const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('change', {bubbles: true}));
    });
}

describe('SessionConfigBand', () => {
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
    });

    it('emits an assembled sweep SessionConfig on Start with the listenerId and selector', () => {
        // Arrange
        const onStart = vi.fn<(c: SessionConfig) => void>();
        render(onStart);

        // Act: defaults are a valid sweep; click Start.
        const startBtn = container.querySelector('[data-testid="start-session"]') as HTMLButtonElement;
        flushSync(() => startBtn.click());

        // Assert
        expect(onStart).toHaveBeenCalledOnce();
        const config = onStart.mock.calls[0][0];
        expect(config.listenerId).toBe('listener-1');
        expect(config.selector.mode).toBe('sweep');
        expect(config.selector.axis).toBeDefined();
        expect(config.selector.targetVoiceIndex).toBeGreaterThanOrEqual(0);
    });

    it('shows no confound block for a clean default config', () => {
        // Arrange / Act
        const onStart = vi.fn<(c: SessionConfig) => void>();
        render(onStart);

        // Assert
        expect(container.querySelector('[data-testid="config-block"]')).toBeNull();
    });

    it('blocks Start and shows the confound message when a preset collides for the chord', () => {
        // Arrange: dom7 (the default quality) at root 460 puts the voice0-5th / voice1-4th
        // coincidence at 2300 Hz; the `ee` preset's f2 sits exactly there, so the shipped
        // confound pre-check blocks in sweep mode.
        const onStart = vi.fn<(c: SessionConfig) => void>();
        render(onStart);
        setValue('[data-testid="root-hz"]', '460');
        setValue('[data-testid="preset-select"]', 'ee');

        // Act
        const startBtn = container.querySelector('[data-testid="start-session"]') as HTMLButtonElement;

        // Assert: block banner shown, Start disabled, and clicking emits nothing.
        expect(container.querySelector('[data-testid="config-block"]')).not.toBeNull();
        expect(startBtn.disabled).toBe(true);
        flushSync(() => startBtn.click());
        expect(onStart).not.toHaveBeenCalled();
    });

    it('re-clamps targetVoiceIndex when switching from dom7 (4 voices) to majorTriad (3 voices)', () => {
        // Arrange
        const onStart = vi.fn<(c: SessionConfig) => void>();
        render(onStart);
        // Pick dom7, set target voice to 3 (valid for dom7), then switch to majorTriad.
        setValue('[data-testid="quality-select"]', 'dom7');
        setValue('[data-testid="target-voice-select"]', '3');
        // Use pitchVariance.drift axis: does not shift fundamentalHz so the confound
        // precheck never blocks, keeping the test focused on the clamping assertion.
        setValue('[data-testid="axis-select"]', 'pitchVariance.drift');

        // Act
        setValue('[data-testid="quality-select"]', 'majorTriad');
        const startBtn = container.querySelector('[data-testid="start-session"]') as HTMLButtonElement;
        flushSync(() => startBtn.click());

        // Assert: target voice clamped to <= 2 for a 3-voice chord.
        expect(onStart.mock.calls[0][0].selector.targetVoiceIndex).toBeLessThanOrEqual(2);
    });
});
