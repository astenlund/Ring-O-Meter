export interface AudioInputDevice {
    deviceId: string;
    label: string;
}

export async function listInputDevices(): Promise<AudioInputDevice[]> {
    // Browsers withhold device labels until the user has granted at least one
    // mic permission. Request a temporary permission so labels are populated.
    const probeStream = await navigator.mediaDevices.getUserMedia({audio: true});
    probeStream.getTracks().forEach((t) => t.stop());

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
