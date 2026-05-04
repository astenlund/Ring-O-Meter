import {type AudioInputDevice} from '../audio/deviceManager';

export interface DeviceSetupProps {
    devices: AudioInputDevice[];
    selectedDeviceId: string;
    onSelect(deviceId: string): void;
}

// Inline controlled picker for the single audio input. Sits above the
// plots in App.tsx and stays mounted across the session: changing the
// selection immediately swaps the active VoiceChannel via slots
// regeneration in App. No Start button - selection auto-applies.
//
// Stays as a separate component (rather than inlining into App.tsx)
// to keep the empty-list / single-list / multi-list branches in one
// place; App's responsibility ends at "selectedDeviceId moved, persist
// to localStorage and rebuild slots".
export function DeviceSetup({devices, selectedDeviceId, onSelect}: DeviceSetupProps) {
    if (devices.length === 0) {
        return <p style={{margin: 0, color: '#888'}}>No audio inputs available.</p>;
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
