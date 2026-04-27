import type {FrameRingReader, FrameSource} from './frameRing';
import type {VoiceChannelEvents} from './voiceChannel';

// Subscriber methods mirror the three VoiceChannel lifecycle events one-to-one.
// All three are required even when a subscriber only cares about a subset:
// useFrameState ignores rebase (the reader instance is shared and already
// updated); the plot subscriber ignores `reader` (it builds its own across the
// worker boundary). A no-op method documents the indifference at the call site
// rather than scattering optional-chains through the multicast loop.
export interface FrameSourceSubscriber {
    onReady(channelId: string, source: FrameSource, reader: FrameRingReader): void;
    onRebased(channelId: string, epochOffsetMs: number): void;
    onGone(channelId: string): void;
}

// Receives lifecycle events from a VoiceChannel (via useVoiceChannels) and
// fans them out to N subscribers. Implements VoiceChannelEvents directly so it
// can be passed straight to useVoiceChannels without an adapter.
//
// Slice 1 adds a third subscriber (the SignalR publish sink) by calling
// subscribe() at app mount; no App.tsx routing changes follow. Two-laptop
// loopback adds a fourth (DisplayClient peer renderer) the same way.
//
// Multicast methods iterate a snapshot of the subscriber list so a subscriber
// that unsubscribes itself from inside its own callback (or unsubscribes a
// sibling) does not skip the next entry in the splice. The snapshot allocates
// a small array per event but events fire at lifecycle scale (channel
// start/stop, AudioContext resume) — never per-frame — so the cost is
// imperceptible against the safety win. Subscribers that subscribe a NEW
// listener from inside a callback do not see that listener fire for the
// current event; they pick it up on the next.
export class FrameSourceRegistry implements VoiceChannelEvents {
    private readonly subscribers: FrameSourceSubscriber[] = [];

    public subscribe(subscriber: FrameSourceSubscriber): () => void {
        this.subscribers.push(subscriber);

        return () => {
            const i = this.subscribers.indexOf(subscriber);
            if (i >= 0) {
                this.subscribers.splice(i, 1);
            }
        };
    }

    public onFrameSourceReady(channelId: string, source: FrameSource, reader: FrameRingReader): void {
        for (const sub of this.subscribers.slice()) {
            sub.onReady(channelId, source, reader);
        }
    }

    public onFrameSourceRebased(channelId: string, epochOffsetMs: number): void {
        for (const sub of this.subscribers.slice()) {
            sub.onRebased(channelId, epochOffsetMs);
        }
    }

    public onFrameSourceGone(channelId: string): void {
        for (const sub of this.subscribers.slice()) {
            sub.onGone(channelId);
        }
    }
}
