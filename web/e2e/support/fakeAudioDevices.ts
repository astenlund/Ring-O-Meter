import {test} from '@playwright/test';

// beforeEach shim that mocks the media-device surface so the app
// sees exactly two synthetic audioinputs (the test exercises the
// two-slot rendering path) and getUserMedia resolves regardless of
// which synthetic deviceId the app picks. Call once at the top of
// each spec file that exercises the audio pipeline.
//
// The previous combined `registerFakeAudioBeforeEach` (in
// support/smoothness.ts) also armed the channel test bridge;
// arming the bridge is now a separate `armChannelTestBridgeBeforeEach`
// concern (see support/suspendResumeProbe.ts) so spec files that
// don't read the bridge (smoothness.spec.ts, staccato-
// smoothness.spec.ts) don't pay for it.
export function registerFakeAudioDevicesBeforeEach(): void {
    test.beforeEach(async ({context}) => {
        await context.addInitScript(() => {
            const md = navigator.mediaDevices;
            const originalEnumerate = md.enumerateDevices.bind(md);
            md.enumerateDevices = async function () {
                const real = await originalEnumerate();
                const makeFake = (deviceId: string, label: string): MediaDeviceInfo => ({
                    deviceId,
                    groupId: 'fake-group',
                    kind: 'audioinput',
                    label,
                    toJSON() {
                        return this;
                    },
                }) as MediaDeviceInfo;
                // Always present exactly the two synthetic audioinputs
                // regardless of host real-device count. A prior count-based
                // branch (return real when audioInputCount >= 2) made the
                // shim sensitive to whether the dev machine had a real mic
                // alongside Chromium's --use-fake-device-for-media-stream:
                // count=2 (real + fake) routed through the real branch and
                // surfaced the host mic; count=1 (fake-only) replaced the
                // single fake with two synthetic entries pointing at
                // deviceIds the app picks deterministically. Discarding
                // real audioinputs unconditionally makes the test behave
                // identically on CI runners and on dev machines.
                const others = real.filter((d) => d.kind !== 'audioinput');

                return [...others, makeFake('fake-audio-1', 'Fake Mic 1'), makeFake('fake-audio-2', 'Fake Mic 2')];
            };
            const originalGetUserMedia = md.getUserMedia.bind(md);
            md.getUserMedia = function (constraints?: MediaStreamConstraints) {
                if (constraints && typeof constraints.audio === 'object') {
                    const audio = {...(constraints.audio as MediaTrackConstraints)};
                    delete (audio as Record<string, unknown>).deviceId;

                    return originalGetUserMedia({...constraints, audio});
                }

                return originalGetUserMedia(constraints);
            };
        });
    });
}
