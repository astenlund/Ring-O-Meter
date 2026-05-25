// web/src/lab/ui/TrialPlayerBand.test.tsx
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {act} from 'react';
import {TrialPlayerBand} from './TrialPlayerBand';
import type {PendingTrial, Pick} from '../protocol/protocolTypes';

const PENDING: PendingTrial = {
    sessionId: 's', listenerId: 'l', selectorMode: 'sweep', sweepAxis: 'fundamental', sweepDelta: 10,
    chordA: {voices: []}, chordB: {voices: []}, seedA: 1, seedB: 2, presentationOrder: ['A', 'B'],
};

let container: HTMLDivElement;
let root: Root;

function render(over: Partial<Parameters<typeof TrialPlayerBand>[0]> = {}) {
    const props = {phase: {kind: 'trial' as const, pending: PENDING}, submitting: false, onChoose: vi.fn<(p: Pick) => void>(), ...over};
    flushSync(() => root.render(<TrialPlayerBand {...props} />));

    return props;
}

describe('TrialPlayerBand', () => {
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
    });

    it('maps "A rings more" to first and "B rings more" to second', () => {
        // Arrange
        const props = render();

        // Act
        flushSync(() => (container.querySelector('[data-testid="choose-a"]') as HTMLButtonElement).click());
        flushSync(() => (container.querySelector('[data-testid="choose-b"]') as HTMLButtonElement).click());
        flushSync(() => (container.querySelector('[data-testid="choose-tie"]') as HTMLButtonElement).click());

        // Assert
        expect(props.onChoose.mock.calls.map((c) => c[0])).toEqual(['first', 'second', 'tie']);
    });

    it('disables the choice buttons while submitting', () => {
        // Arrange / Act
        render({submitting: true});

        // Assert
        expect((container.querySelector('[data-testid="choose-a"]') as HTMLButtonElement).disabled).toBe(true);
        expect((container.querySelector('[data-testid="choose-tie"]') as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows the sweep-complete state and hides choice buttons', () => {
        // Arrange / Act
        render({phase: {kind: 'sweep-complete'}});

        // Assert
        expect(container.querySelector('[data-testid="sweep-complete"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="choose-a"]')).toBeNull();
    });

    it('shows the audio-unavailable state with a resume action', () => {
        // Arrange
        const onResume = vi.fn();

        // Act
        render({phase: {kind: 'audio-unavailable', onResume}});
        flushSync(() => (container.querySelector('[data-testid="resume-audio"]') as HTMLButtonElement).click());

        // Assert
        expect(onResume).toHaveBeenCalledOnce();
    });

    it('does not expose any A/B parameter readout (blind)', () => {
        // Arrange / Act
        render();

        // Assert: the toggle is labeled only A / B; no delta/axis text in the player body.
        const body = container.querySelector('[data-testid="player-body"]')!;
        expect(body.textContent).not.toContain('fundamental');
        expect(body.textContent).not.toContain('10');
    });

    it('signals audio-unavailable when a Play resume is blocked', async () => {
        // Arrange: a player whose play() resolves false (autoplay-blocked).
        const onAudioUnavailable = vi.fn();
        const audio = {play: async () => false, pause: async () => undefined, setActive: () => undefined};
        render({audio, onAudioUnavailable});

        // Act
        await act(async () => {
            (container.querySelector('[data-testid="play-pause"]') as HTMLButtonElement).click();
        });

        // Assert
        expect(onAudioUnavailable).toHaveBeenCalledOnce();
    });
});
