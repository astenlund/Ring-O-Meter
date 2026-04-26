import type {VoiceEntry} from '../plot/plotMessages';

// Boundary that normalises a per-deployment roster shape into the
// renderer's VoiceEntry contract. Today only the SingerClient slot
// path exists; slice 1's DisplayClient subscribes to the SignalR
// hub's PeerInfo broadcast and will add a sibling peersToVoices()
// alongside, with its own color-assignment policy (PeerInfo is a
// wire-level record and carries no render attributes).

export interface SlotRosterEntry {
    channelId: string;
    deviceLabel: string;
    color: string;
}

export function slotsToVoices(
    slots: ReadonlyArray<SlotRosterEntry>,
): ReadonlyArray<VoiceEntry> {
    return slots.map((slot) => ({
        channelId: slot.channelId,
        label: slot.deviceLabel,
        color: slot.color,
    }));
}
