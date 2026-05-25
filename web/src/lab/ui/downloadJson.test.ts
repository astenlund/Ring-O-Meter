import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {downloadJson} from './downloadJson';

describe('downloadJson', () => {
    beforeEach(() => {
        // jsdom lacks URL.createObjectURL / revokeObjectURL.
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL: vi.fn(() => 'blob:fake'),
            revokeObjectURL: vi.fn(),
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('creates and clicks an anchor with the given filename, then revokes the URL', () => {
        // Arrange
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

        // Act
        downloadJson('{"ok":true}', 'calibration.json');

        // Assert
        expect(URL.createObjectURL).toHaveBeenCalledOnce();
        expect(clickSpy).toHaveBeenCalledOnce();
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
        clickSpy.mockRestore();
    });
});
