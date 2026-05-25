// web/src/lab/ui/StatusStrip.test.tsx
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {StatusStrip} from './StatusStrip';

let container: HTMLDivElement;
let root: Root;

describe('StatusStrip', () => {
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
    });

    it('labels the blocked writer-lock state', () => {
        // Arrange / Act
        flushSync(() => root.render(<StatusStrip listenerId="abcd1234ef" listenerEphemeral={false} lock="blocked" storage="ok" />));

        // Assert
        expect(container.querySelector('[data-testid="lock-state"]')!.textContent).toContain('another tab');
    });

    it('marks the listener id ephemeral and shows the storage state', () => {
        // Arrange / Act
        flushSync(() => root.render(<StatusStrip listenerId="abcd1234ef" listenerEphemeral={true} lock="held" storage="unavailable" />));

        // Assert
        expect(container.querySelector('[data-testid="listener-id"]')!.textContent).toContain('ephemeral');
        expect(container.querySelector('[data-testid="storage-state"]')!.textContent).toContain('unavailable');
    });

    it('disables the reset button when resetDisabled is set', () => {
        // Arrange / Act
        flushSync(() => root.render(<StatusStrip listenerId="abcd1234ef" listenerEphemeral={false} lock="held" storage="ok" onResetListener={vi.fn()} resetDisabled={true} />));

        // Assert
        expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    });
});
