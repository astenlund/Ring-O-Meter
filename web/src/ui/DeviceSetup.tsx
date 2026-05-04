import {type AudioInputDevice} from '../audio/deviceManager';

export interface DeviceSetupProps {
    // null = enumeration in flight; empty array = enumeration done but no
    // inputs found; populated = ready. All three states render a <select>
    // element so the row's width and height stay constant across the
    // transition (otherwise the picker pops in and pushes adjacent
    // elements when the row's flex layout reflows).
    devices: AudioInputDevice[] | null;
    selectedDeviceId: string;
    onSelect(deviceId: string): void;
}

// Inline controlled picker for the single audio input. Sits above the
// plots in App.tsx and stays mounted across the session: changing the
// selection immediately swaps the active VoiceChannel via slots
// regeneration in App. No Start button - selection auto-applies.
//
// Always renders a <select> element (even during enumeration) so the
// surrounding layout does not jump when devices arrive. Loading /
// empty states show a disabled select with a placeholder option.
export function DeviceSetup({devices, selectedDeviceId, onSelect}: DeviceSetupProps) {
    if (devices === null) {
        return (
            <select disabled value="">
                <option value="">Loading inputs...</option>
            </select>
        );
    }

    if (devices.length === 0) {
        return (
            <select disabled value="">
                <option value="">No audio inputs available</option>
            </select>
        );
    }

    return (
        <select
            value={selectedDeviceId}
            onChange={(e) => onSelect(e.target.value)}
        >
            {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
            ))}
        </select>
    );
}
