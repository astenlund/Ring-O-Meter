// web/src/lab/ui/seamlessLoop.ts
// Bakes an equal-power crossfade into a loop so a buffer can be played with
// loop=true and wrap click-free, even for the non-periodic variance axes. Method:
// take the region [loopStart, loopEnd], overlap-add its tail (length `crossfade`)
// onto its head with an equal-power (sin/cos) curve, and trim the result by the
// crossfade length. When the trimmed buffer loops, its end already blends into its
// start. Pure sample math; allocates one new AudioBuffer.

import {equalPowerGains} from './equalPower';

export function makeSeamlessLoopBuffer(source: AudioBuffer, loopStartS: number, loopEndS: number, crossfadeS: number): AudioBuffer {
    const sr = source.sampleRate;
    const channels = source.numberOfChannels;

    const startSample = Math.max(0, Math.floor(loopStartS * sr));
    const endSample = Math.min(source.length, Math.floor(loopEndS * sr));
    const regionLen = Math.max(1, endSample - startSample);

    // Clamp crossfade to at most half the region so head and tail windows don't overlap.
    const xfade = Math.min(Math.floor(crossfadeS * sr), Math.floor(regionLen / 2));
    const outLen = Math.max(1, regionLen - xfade);

    const out = new AudioBuffer({numberOfChannels: channels, length: outLen, sampleRate: sr});

    for (let ch = 0; ch < channels; ch++) {
        const src = source.getChannelData(ch);
        const dst = out.getChannelData(ch);

        // Body: region[0 .. outLen) copied straight.
        for (let i = 0; i < outLen; i++) {
            dst[i] = src[startSample + i];
        }

        // Crossfade the first `xfade` samples: blend head (already in dst) with the
        // region tail using equal-power weights. fadeIn^2 + fadeOut^2 = 1.
        for (let i = 0; i < xfade; i++) {
            const t = (i + 1) / (xfade + 1);
            const [fadeOut, fadeIn] = equalPowerGains(t);
            const head = src[startSample + i];
            const tail = src[startSample + outLen + i];
            dst[i] = head * fadeIn + tail * fadeOut;
        }
    }

    return out;
}
