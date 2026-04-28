import {useEffect, useState} from 'react';
import {
    enumerateInputDevices,
    probeInputDevicesPermission,
    type AudioInputDevice,
} from './deviceManager';

export interface InputDevicesState {
    devices: AudioInputDevice[] | null;
    error: Error | null;
}

// Maintains a live list of audio input devices for the lifetime of the
// hook. Probes for mic permission once on mount (so labels populate),
// then re-enumerates on every navigator.mediaDevices 'devicechange'
// event so a USB interface plug/unplug is reflected without a page
// reload.
//
// devices is null while the initial probe is in flight OR when an error
// has occurred; consumers should render a "discovering..." or error
// placeholder while it is null. After the first successful enumeration
// it stays non-null unless an error occurs.
export function useInputDevices(): InputDevicesState {
    const [state, setState] = useState<InputDevicesState>({devices: null, error: null});

    useEffect(() => {
        const md = navigator.mediaDevices;
        let mounted = true;
        let probeComplete = false;

        const refresh = async (): Promise<void> => {
            try {
                const devices = await enumerateInputDevices();
                if (mounted) {
                    // Bail when the new list is content-equal to the previous
                    // successful list. Browsers fire 'devicechange' for default-
                    // device shifts and other metadata events that don't change
                    // the audio-input set; returning prev keeps React from
                    // re-rendering DeviceSetup (and re-running its
                    // reconcileSelection effect) for those no-op fires. Recovery
                    // from an error state (prev.error !== null) always re-renders
                    // even when devices match.
                    setState((prev) => {
                        if (prev.devices !== null
                            && prev.error === null
                            && prev.devices.length === devices.length
                            && prev.devices.every((d, i) =>
                                d.deviceId === devices[i].deviceId && d.label === devices[i].label)) {
                            return prev;
                        }

                        return {devices, error: null};
                    });
                }
            }
            catch (err) {
                if (mounted) {
                    setState({devices: null, error: err as Error});
                }
            }
        };

        // Guard: only re-enumerate on devicechange after the probe has
        // succeeded. Before probe completion the browser may withhold
        // labels, so a hot-plug during the probe window would briefly
        // commit empty-label entries to React state. After a probe failure
        // (permission denied) there is nothing useful enumeration can tell
        // us; the user must reload and re-grant permission.
        const onDeviceChange = (): void => {
            if (probeComplete) {
                void refresh();
            }
        };

        md.addEventListener('devicechange', onDeviceChange);

        probeInputDevicesPermission()
            .then(() => {
                probeComplete = true;

                return refresh();
            })
            .catch((err: Error) => {
                if (mounted) {
                    setState({devices: null, error: err});
                }
            });

        return () => {
            mounted = false;
            md.removeEventListener('devicechange', onDeviceChange);
        };
    }, []);

    return state;
}
