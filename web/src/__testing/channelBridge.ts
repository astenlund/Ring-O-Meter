// Test-only bridge between VoiceChannel and out-of-process harnesses
// (Playwright e2e, future vitest browser tests). Production never arms
// the global, so publishChannel short-circuits and the helpers leave
// no observable trace.
//
// REALM BOUNDARY NOTE: Playwright's `page.evaluate` and
// `addInitScript` bodies are serialised into the browser realm and
// cannot import from this module. Such code MUST re-declare the
// ChannelTestBridge shape inline with a comment pointing here. There
// is no compiler check that catches drift across that boundary; the
// contract is enforced by hand. CHANNEL_BRIDGE_KEY can still be
// threaded in as the addInitScript / page.evaluate arg, so at least
// the global name is single-sourced.

import type {FrameRingReader} from '../audio/frameRing';

export const CHANNEL_BRIDGE_KEY = '__ringOMeterChannels';

export interface ChannelTestBridge {
    audioContext: AudioContext;
    reader: FrameRingReader;
    // Incremented by VoiceChannel.handleStateChange after the offset
    // propagation completes, so a harness can wait for the rebase to
    // have observably taken effect rather than racing statechange
    // listener order against audioContext.resume().
    rebaseCount: number;
}

type ChannelBridgeMap = Map<string, ChannelTestBridge>;

function bridgeMap(): ChannelBridgeMap | undefined {
    return (globalThis as Record<string, unknown>)[CHANNEL_BRIDGE_KEY] as
        | ChannelBridgeMap
        | undefined;
}

// Registers a channel with the bridge if one is armed; returns the
// live entry (mutating its rebaseCount field is observed by the
// harness on its next read) or null if the bridge is not armed. The
// armer (today: smoothness.spec.ts via Playwright addInitScript)
// assigns `new Map()` to globalThis[CHANNEL_BRIDGE_KEY] inline because
// addInitScript closures cannot import from this module.
export function publishChannel(
    channelId: string,
    audioContext: AudioContext,
    reader: FrameRingReader,
): ChannelTestBridge | null {
    const map = bridgeMap();
    if (!map) {
        return null;
    }
    const entry: ChannelTestBridge = {audioContext, reader, rebaseCount: 0};
    map.set(channelId, entry);

    return entry;
}

// Removes a channel's entry from the bridge. No-op when the bridge
// is not armed.
export function revokeChannel(channelId: string): void {
    bridgeMap()?.delete(channelId);
}
