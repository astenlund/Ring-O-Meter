import {describe, expect, it} from 'vitest';
import {hexToRgba} from './color';

describe('hexToRgba', () => {
    it('parses 3-digit hex', () => {
        // Arrange
        const out = new Float32Array(4);

        // Act
        hexToRgba('#5cf', out);

        // Assert
        expect(out[0]).toBeCloseTo(85 / 255, 5);
        expect(out[1]).toBeCloseTo(204 / 255, 5);
        expect(out[2]).toBeCloseTo(255 / 255, 5);
        expect(out[3]).toBe(1);
    });

    it('parses 6-digit hex', () => {
        // Arrange
        const out = new Float32Array(4);

        // Act
        hexToRgba('#55ccff', out);

        // Assert
        expect(out[0]).toBeCloseTo(85 / 255, 5);
        expect(out[1]).toBeCloseTo(204 / 255, 5);
        expect(out[2]).toBeCloseTo(255 / 255, 5);
        expect(out[3]).toBe(1);
    });

    it('throws on unsupported input', () => {
        // Arrange
        const out = new Float32Array(4);

        // Act / Assert
        expect(() => hexToRgba('5cf', out)).toThrow();
        expect(() => hexToRgba('#abcd', out)).toThrow();
        expect(() => hexToRgba('rgb(85, 204, 255)', out)).toThrow();
    });
});
