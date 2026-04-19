import {useEffect} from 'react';
import {TARGET_SAMPLE_RATE_HZ} from './constants';
import {openInputStream} from './deviceManager';
import {VoiceChannel} from './voiceChannel';
import type {AnalysisFrame} from '../wire/frames';

export interface VoiceChannelSlot {
    channelId: string;
    voiceLabel: string;
    deviceId: string;
}

// Owns the AudioContext + VoiceChannel[] lifecycle for a given set of slots.
// Creates a context per effect pass, tears it down on slots/onFrame change or
// unmount, and runs mic-stream acquisition + worklet load for each slot in
// parallel (getUserMedia can cost hundreds of ms per device, so serialising
// would double startup latency). Any setup failure tears down the whole
// context to avoid leaking hardware while the user stares at an error.
//
// Slice 0 feeds onFrame directly into React state; slice 1 will feed it into
// a SignalR publishFrame call. The hook's shape is intentionally stable
// across that swap.
export function useVoiceChannels(
    slots: readonly VoiceChannelSlot[] | null,
    onFrame: (frame: AnalysisFrame) => void,
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
            deviceId: slot.deviceId,
            audioContext,
            onFrame,
        }));

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
            const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
            if (failures.length === 0) {
                return;
            }
            failures.forEach((f) => console.error('Setup failed', f.reason));
            channels.forEach((c) => c.stop());
            audioContext.close().catch(() => undefined);
        });

        return () => {
            cancelled = true;
            channels.forEach((c) => c.stop());
            audioContext.close().catch(() => undefined);
        };
    }, [slots, onFrame]);
}
