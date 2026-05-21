// Lowest-free-slot allocator for the chord-bars channel-to-slot mapping.
// On attach, returns the lowest non-occupied index in [0, capacity); on
// detach, the slot is freed automatically when the caller removes the
// channelId from its backing map. Returns -1 when capacity is exhausted
// so the caller can silently drop the channel.
//
// Replaces a monotonically-incrementing counter that never reset on
// detach: in long-running sessions with mic plug-unplug, the counter
// eventually exceeded MAX_VOICES and the downstream renderer silently
// dropped voices even when the active count was well under capacity.

export function allocateLowestFreeSlot(
    occupiedSlots: Iterable<number>,
    capacity: number,
): number {
    // The Set allocation is fine here: this function runs on the rare
    // attach event, not the frame-rate path.
    const used = new Set<number>(occupiedSlots);
    for (let i = 0; i < capacity; i++) {
        if (!used.has(i)) {
            return i;
        }
    }

    return -1;
}
