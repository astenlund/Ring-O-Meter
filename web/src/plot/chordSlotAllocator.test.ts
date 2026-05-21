import {describe, it, expect} from 'vitest';
import {allocateLowestFreeSlot} from './chordSlotAllocator';

describe('allocateLowestFreeSlot', () => {
    it('returns 0 when no slots are in use', () => {
        // Arrange
        const used: number[] = [];

        // Act
        const slot = allocateLowestFreeSlot(used, 8);

        // Assert
        expect(slot).toBe(0);
    });

    it('returns the lowest free index when some are in use', () => {
        // Arrange
        const used = [0, 2, 3];

        // Act
        const slot = allocateLowestFreeSlot(used, 8);

        // Assert
        expect(slot).toBe(1);
    });

    it('returns -1 when capacity is exhausted', () => {
        // Arrange
        const used = [0, 1, 2, 3, 4, 5, 6, 7];

        // Act
        const slot = allocateLowestFreeSlot(used, 8);

        // Assert
        expect(slot).toBe(-1);
    });

    it('long attach-detach cycles never exceed capacity', () => {
        // Arrange: simulate mic plug-unplug cycles in a long-running
        // session. The previous monotonic-counter bug would have produced
        // slot indices exceeding capacity after enough cycles; this test
        // pins the free-list behavior that prevents it.
        const occupied = new Map<string, number>();
        const capacity = 8;

        // Act: 100 cycles of attach 4, detach 4.
        for (let cycle = 0; cycle < 100; cycle++) {
            const ids = [`c${cycle}a`, `c${cycle}b`, `c${cycle}c`, `c${cycle}d`];
            for (const id of ids) {
                const slot = allocateLowestFreeSlot(occupied.values(), capacity);
                expect(slot).toBeGreaterThanOrEqual(0);
                expect(slot).toBeLessThan(capacity);
                occupied.set(id, slot);
            }
            for (const id of ids) {
                occupied.delete(id);
            }
        }

        // Assert
        expect(occupied.size).toBe(0);
    });
});
