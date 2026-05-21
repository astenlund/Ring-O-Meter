import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {RingIndicatorDot, type RingIndicatorState} from './RingIndicatorDot';

let container: HTMLDivElement;
let root: Root;

function renderDot(state: RingIndicatorState) {
    flushSync(() => {
        root.render(<RingIndicatorDot state={state} />);
    });
}

describe('RingIndicatorDot', () => {
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => {
            root.unmount();
        });
        container.remove();
    });

    it('renders a dot with aria-label ring-green for state "green"', () => {
        // Arrange / Act
        renderDot('green');

        // Assert
        const span = container.querySelector('[aria-label="ring-green"]');
        expect(span).not.toBeNull();
    });

    it('renders a dot with aria-label ring-yellow for state "yellow"', () => {
        // Arrange / Act
        renderDot('yellow');

        // Assert
        const span = container.querySelector('[aria-label="ring-yellow"]');
        expect(span).not.toBeNull();
    });

    it('renders a dot with aria-label ring-red for state "red"', () => {
        // Arrange / Act
        renderDot('red');

        // Assert
        const span = container.querySelector('[aria-label="ring-red"]');
        expect(span).not.toBeNull();
    });

    it('applies distinct background colors for each state', () => {
        // Arrange
        const colors: Record<string, string> = {};
        for (const state of ['green', 'yellow', 'red'] as const) {
            renderDot(state);
            const span = container.querySelector('span') as HTMLSpanElement;
            colors[state] = span.style.backgroundColor;
        }

        // Assert: all three colors are non-empty and distinct
        expect(Object.values(colors).every(c => c.length > 0)).toBe(true);
        expect(new Set(Object.values(colors)).size).toBe(3);
    });

    it('renders nothing for state null', () => {
        // Arrange / Act
        renderDot(null);

        // Assert
        expect(container.querySelector('span')).toBeNull();
        expect(container.innerHTML).toBe('');
    });
});
