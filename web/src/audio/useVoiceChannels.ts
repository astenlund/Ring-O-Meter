import {useEffect} from 'react';
import {TARGET_SAMPLE_RATE_HZ} from './constants';
import {openInputStream} from './deviceManager';
import {VoiceChannel, type VoiceChannelEvents} from './voiceChannel';

export interface VoiceChannelSlot {
    channelId: string;
    voiceLabel: string;
    deviceId: string;
}

// Owns the AudioContext + VoiceChannel[] lifecycle for a given set of slots.
// Creates a context per effect pass, tears it down on slots change or
// unmount, and runs mic-stream acquisition + worklet load for each slot in
// parallel (getUserMedia can cost hundreds of ms per device, so serialising
// would double startup latency). Any setup failure tears down the whole
// context to avoid leaking hardware while the user stares at an error.
//
// Per-frame data flows via SAB now (see frameRing.ts); this hook only
// forwards lifecycle events. Slice 1's SignalR DisplayClient will reuse
// the same event shape with a different event source.
//
// `events` must be referentially stable across renders (useMemo over
// useCallback'd handlers at the call site); this hook treats it as an
// effect dependency so a fresh object identity forces a full channel
// teardown + restart.
export function useVoiceChannels(
    slots: readonly VoiceChannelSlot[] | null,
    events: VoiceChannelEvents,
): void {
    useEffect(() => {
        if (!slots) {
            return;
        }

        let cancelled = false;
        const audioContext = new AudioContext({sampleRate: TARGET_SAMPLE_RATE_HZ});

        const channels = slots.map((slot) => new VoiceChannel({
            channelId: slot.channelId,
            voiceLabel: slot.voiceLabel,
            audioContext,
            ...events,
        }));

        // Shared teardown path for both the effect-cleanup and the setup-failure
        // branch: stop every channel, close the AudioContext. Any future step
        // (e.g. disposing timers, nulling refs) belongs here so the two branches
        // stay in lockstep.
        const teardown = () => {
            channels.forEach((c) => c.stop());
            audioContext.close().catch(() => undefined);
        };

        // Per-branch cancel checks: one before .start() (if the effect tore
        // down during the stream await), one after (if it tore down during
        // the worklet addModule await). Promise.allSettled (not all) so one
        // mic failing (permission denied, device vanished) does not leave
        // the other branch running without a cleanup hook.
        Promise.allSettled(channels.map(async (channel, i) => {
            const stream = await openInputStream(slots[i].deviceId);
            if (cancelled) {
                stream.getTracks().forEach((t) => t.stop());

                return;
            }
            await channel.start(stream);
            if (cancelled) {
                channel.stop();
            }
        })).then((results) => {
            if (cancelled) {
                // Cleanup already tore everything down; any rejections here are
                // almost certainly cancellation-triggered (closed context, aborted
                // stream). Suppress the log so real user-visible failures aren't
                // drowned out by teardown noise.
                return;
            }
            const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
            if (failures.length === 0) {
                return;
            }
            failures.forEach((f) => console.error('Setup failed', f.reason));
            teardown();
        });

        return () => {
            cancelled = true;
            teardown();
        };
    }, [slots, events]);
}
