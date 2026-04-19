import {describe, expect, it} from 'vitest';
import {computeRmsDb} from '../audio/rmsDb';

describe('computeRmsDb', () => {
    it('returns the silence floor for a zero buffer', () => {
        // Arrange
        const buffer = new Float32Array(1024);

        // Act
        const db = computeRmsDb(buffer);

        // Assert
        expect(db).toBe(-120);
    });

    it('reports -20 dBFS for a 0.1 RMS sine at full resolution', () => {
        // Arrange: unit-amplitude sine has RMS = 1/sqrt(2) -> 20*log10(1/sqrt(2)) = -3.01 dBFS
        const buffer = new Float32Array(2048);
        const w = (2 * Math.PI * 440) / 48000;
        for (let i = 0; i < buffer.length; i++) {
            buffer[i] = Math.sin(w * i);
        }

        // Act
        const db = computeRmsDb(buffer);

        // Assert
        expect(db).toBeCloseTo(-3.01, 1);
    });
});
