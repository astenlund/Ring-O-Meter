import {useEffect, useState} from 'react';
import {type AudioInputDevice} from '../audio/deviceManager';
import {useInputDevices} from '../audio/useInputDevices';

const NO_DEVICE_ID = '';

export interface DeviceSelection {
    voice1: AudioInputDevice;

    // null when only one input is available (e.g. an iPad's built-in mic)
    // or when the user has not chosen a second input. App.tsx maps a null
    // voice2 to a single-slot session.
    voice2: AudioInputDevice | null;
}

export interface DeviceSetupProps {
    onConfirm(selection: DeviceSelection): void;
}

interface SelectionState {
    voice1Id: string;

    // '' means "(none) — single-mic session" when voice2Manual is true,
    // and "not yet auto-picked" when voice2Manual is false. The flag is
    // what makes that distinction unambiguous across device-list
    // changes; without it, an explicit "(none)" pick would be
    // indistinguishable from the initial pre-reconciliation state and
    // would be clobbered back to an auto-picked device on the next
    // 'devicechange' fire.
    voice2Id: string;
    voice2Manual: boolean;
}

// Reconciles selection state against the latest device list. Re-runs on
// every device list change (initial probe completion, USB plug/unplug).
// Returning the full triple from one pure function (rather than three
// independent setState updaters) lets voice2 see the freshly-resolved
// voice1 in the same pass, which functional updaters cannot — setState
// updaters queue, they do not synchronously update peer state.
function reconcileSelection(
    devices: readonly AudioInputDevice[],
    current: SelectionState,
): SelectionState {
    const voice1Valid = current.voice1Id !== NO_DEVICE_ID
        && devices.some((d) => d.deviceId === current.voice1Id);
    const voice1Id = voice1Valid ? current.voice1Id : devices[0]?.deviceId ?? NO_DEVICE_ID;

    if (devices.length < 2) {
        // Voice 2 picker is hidden in this branch; preserve the user's
        // last pick (id + manual flag) so it can be restored if a second
        // device returns later. submit() re-checks devices.length before
        // reading voice2Id.
        return {voice1Id, voice2Id: current.voice2Id, voice2Manual: current.voice2Manual};
    }

    if (current.voice2Manual) {
        // NO_DEVICE_ID is always a valid manual choice ("(none)"); a
        // non-empty id is valid only if the device still exists and
        // isn't a voice1 collision.
        const voice2Valid = current.voice2Id === NO_DEVICE_ID
            || (current.voice2Id !== voice1Id
                && devices.some((d) => d.deviceId === current.voice2Id));
        const voice2Id = voice2Valid ? current.voice2Id : NO_DEVICE_ID;

        return {voice1Id, voice2Id, voice2Manual: true};
    }

    // Auto-pick: default to the first device that isn't voice1.
    const voice2Id = devices.find((d) => d.deviceId !== voice1Id)?.deviceId ?? NO_DEVICE_ID;

    return {voice1Id, voice2Id, voice2Manual: false};
}

export function DeviceSetup({onConfirm}: DeviceSetupProps) {
    const {devices, error: enumerationError} = useInputDevices();
    const [selection, setSelection] = useState<SelectionState>(
        {voice1Id: NO_DEVICE_ID, voice2Id: NO_DEVICE_ID, voice2Manual: false},
    );
    const [submitError, setSubmitError] = useState<string | null>(null);

    useEffect(() => {
        if (!devices) {
            return;
        }
        setSelection((current) => reconcileSelection(devices, current));
    }, [devices]);

    if (enumerationError) {
        return <p style={{color: 'crimson'}}>Could not enumerate audio inputs: {enumerationError.message}</p>;
    }

    if (!devices) {
        return <p>Discovering audio inputs...</p>;
    }

    if (devices.length === 0) {
        return <p>No audio inputs found. Connect a microphone and try again.</p>;
    }

    const submit = (): void => {
        const v1 = devices.find((d) => d.deviceId === selection.voice1Id);
        if (!v1) {
            setSubmitError('Pick an input for Voice 1.');

            return;
        }

        // Single-mic session: only one device available, OR user explicitly
        // chose "(none)" for Voice 2 with multiple devices available.
        if (devices.length < 2 || selection.voice2Id === NO_DEVICE_ID) {
            onConfirm({voice1: v1, voice2: null});

            return;
        }

        const v2 = devices.find((d) => d.deviceId === selection.voice2Id);
        if (!v2 || v1.deviceId === v2.deviceId) {
            setSubmitError('Pick two different inputs.');

            return;
        }
        onConfirm({voice1: v1, voice2: v2});
    };

    const showVoice2 = devices.length >= 2;

    return (
        <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            <h2>{showVoice2 ? 'Pick inputs' : 'One input available'}</h2>
            <label>
                Voice 1
                <select
                    value={selection.voice1Id}
                    onChange={(e) => setSelection((s) => ({...s, voice1Id: e.target.value}))}
                >
                    {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
            </label>
            {showVoice2 && (
                <label>
                    Voice 2
                    <select
                        value={selection.voice2Id}
                        onChange={(e) => setSelection((s) => ({
                            ...s,
                            voice2Id: e.target.value,
                            voice2Manual: true,
                        }))}
                    >
                        <option value={NO_DEVICE_ID}>(none)</option>
                        {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                    </select>
                </label>
            )}
            {submitError && <p style={{color: 'crimson'}}>{submitError}</p>}
            <button type="button" onClick={submit}>Start</button>
        </div>
    );
}
