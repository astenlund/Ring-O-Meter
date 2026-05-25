// web/src/lab/ui/StoreAdminRow.test.tsx
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {StoreAdminRow} from './StoreAdminRow';

let container: HTMLDivElement;
let root: Root;

describe('StoreAdminRow', () => {
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
    });

    it('calls onExport when Export is clicked', () => {
        // Arrange
        const onExport = vi.fn();
        flushSync(() => root.render(<StoreAdminRow onExport={onExport} onClearAll={vi.fn()} busy={false} />));

        // Act
        flushSync(() => (container.querySelector('[data-testid="export"]') as HTMLButtonElement).click());

        // Assert
        expect(onExport).toHaveBeenCalledOnce();
    });

    it('requires a confirm before calling onClearAll', () => {
        // Arrange
        const onClearAll = vi.fn();
        flushSync(() => root.render(<StoreAdminRow onExport={vi.fn()} onClearAll={onClearAll} busy={false} />));

        // Act: first click reveals confirm, does not clear.
        flushSync(() => (container.querySelector('[data-testid="clear-all"]') as HTMLButtonElement).click());
        expect(onClearAll).not.toHaveBeenCalled();
        // Confirm.
        flushSync(() => (container.querySelector('[data-testid="clear-all-confirm"]') as HTMLButtonElement).click());

        // Assert
        expect(onClearAll).toHaveBeenCalledOnce();
    });

    it('disables both actions when busy', () => {
        // Arrange / Act
        flushSync(() => root.render(<StoreAdminRow onExport={vi.fn()} onClearAll={vi.fn()} busy={true} />));

        // Assert
        expect((container.querySelector('[data-testid="export"]') as HTMLButtonElement).disabled).toBe(true);
        expect((container.querySelector('[data-testid="clear-all"]') as HTMLButtonElement).disabled).toBe(true);
    });
});
