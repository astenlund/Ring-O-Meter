import {describe, it, expect} from 'vitest';
import {shouldRenderLab} from './labGate';

describe('shouldRenderLab', () => {
    it('is true only in dev on the /lab path', () => {
        // Arrange / Act / Assert
        expect(shouldRenderLab(true, '/lab')).toBe(true);
        expect(shouldRenderLab(false, '/lab')).toBe(false);
        expect(shouldRenderLab(true, '/')).toBe(false);
        expect(shouldRenderLab(true, '/lab/')).toBe(false);
    });
});
