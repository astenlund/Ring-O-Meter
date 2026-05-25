// web/src/lab/ui/CoefficientDashboard.test.tsx
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {CoefficientDashboard} from './CoefficientDashboard';
import type {CoefficientResult} from '../fit/coefficients';

let container: HTMLDivElement;
let root: Root;

describe('CoefficientDashboard', () => {
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
    });

    it('renders all twelve axes with status chips', () => {
        // Arrange
        const coeffs = new Map<string, CoefficientResult>([
            ['fundamental', {status: 'ok', n: 30, slope: 0.5, ci95: [0.3, 0.7], intercept: 0, covariance: [[0, 0], [0, 0]]}],
        ]);

        // Act
        flushSync(() => root.render(<CoefficientDashboard coefficients={coeffs} skippedMalformedCount={0} onRefresh={() => undefined} />));

        // Assert
        const rows = container.querySelectorAll('[data-axis]');
        expect(rows.length).toBe(12);
        const fundamental = container.querySelector('[data-axis="fundamental"]') as HTMLElement;
        expect(fundamental.dataset['status']).toBe('ok');
    });

    it('shows n / 20 progress for an untouched axis', () => {
        // Arrange / Act
        flushSync(() => root.render(<CoefficientDashboard coefficients={new Map()} skippedMalformedCount={0} onRefresh={() => undefined} />));

        // Assert
        const onset = container.querySelector('[data-axis="onset"]') as HTMLElement;
        expect(onset.dataset['status']).toBe('insufficient-data');
        expect(onset.textContent).toContain('0 / 20');
    });

    it('surfaces skippedMalformedCount when non-zero', () => {
        // Arrange / Act
        flushSync(() => root.render(<CoefficientDashboard coefficients={new Map()} skippedMalformedCount={3} onRefresh={() => undefined} />));

        // Assert
        expect(container.querySelector('[data-testid="skipped-count"]')!.textContent).toContain('3');
    });
});
