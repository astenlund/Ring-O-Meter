import {useEffect, useState} from 'react';
import {listInputDevices, type AudioInputDevice} from '../audio/deviceManager';

export interface DeviceSelection {
    voice1: AudioInputDevice;
    voice2: AudioInputDevice;
}

export interface DeviceSetupProps {
    onConfirm(selection: DeviceSelection): void;
}

export function DeviceSetup({onConfirm}: DeviceSetupProps) {
    const [devices, setDevices] = useState<AudioInputDevice[] | null>(null);
    const [voice1Id, setVoice1Id] = useState<string>('');
    const [voice2Id, setVoice2Id] = useState<string>('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        listInputDevices()
            .then((list) => {
                if (!mounted) {
                    return;
                }
                setDevices(list);
                if (list[0]) {
                    setVoice1Id(list[0].deviceId);
                }
                if (list[1]) {
                    setVoice2Id(list[1].deviceId);
                }
            })
            .catch((err: Error) => mounted && setError(err.message));

        return () => {
            mounted = false;
        };
    }, []);

    if (error) {
        return <p style={{color: 'crimson'}}>Could not enumerate audio inputs: {error}</p>;
    }

    if (!devices) {
        return <p>Discovering audio inputs...</p>;
    }

    if (devices.length < 2) {
        return <p>Need at least two audio inputs. Found {devices.length}.</p>;
    }

    const submit = (): void => {
        const v1 = devices.find((d) => d.deviceId === voice1Id);
        const v2 = devices.find((d) => d.deviceId === voice2Id);
        if (!v1 || !v2 || v1.deviceId === v2.deviceId) {
            setError('Pick two different inputs.');

            return;
        }
        onConfirm({voice1: v1, voice2: v2});
    };

    return (
        <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            <h2>Pick two inputs</h2>
            <label>
                Voice 1
                <select value={voice1Id} onChange={(e) => setVoice1Id(e.target.value)}>
                    {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
            </label>
            <label>
                Voice 2
                <select value={voice2Id} onChange={(e) => setVoice2Id(e.target.value)}>
                    {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
            </label>
            <button type="button" onClick={submit}>Start</button>
        </div>
    );
}
