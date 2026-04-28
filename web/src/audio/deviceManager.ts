export interface AudioInputDevice {
    deviceId: string;
    label: string;
}

// Browsers withhold device labels (and on some platforms, the deviceId
// list itself) until the page has been granted at least one mic
// permission. A throwaway getUserMedia({audio:true}) call grants it for
// the lifetime of the document; subsequent enumerateInputDevices() calls
// then return populated labels without re-prompting and without opening
// fresh streams. Split from enumerateInputDevices so 'devicechange'
// re-enumerations skip the probe (extra getUserMedia round-trips can
// briefly flash the mic indicator on iOS Safari).
export async function probeInputDevicesPermission(): Promise<void> {
    const probeStream = await navigator.mediaDevices.getUserMedia({audio: true});
    probeStream.getTracks().forEach((t) => t.stop());
}

export async function enumerateInputDevices(): Promise<AudioInputDevice[]> {
    const all = await navigator.mediaDevices.enumerateDevices();

    return all
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({deviceId: d.deviceId, label: d.label || `Input ${d.deviceId.slice(0, 6)}`}));
}

export async function openInputStream(deviceId: string): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
        audio: {
            deviceId: {exact: deviceId},
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
        },
    });
}
