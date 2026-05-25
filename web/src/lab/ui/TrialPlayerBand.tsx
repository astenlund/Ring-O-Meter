// web/src/lab/ui/TrialPlayerBand.tsx
// Band 2: the blind A/B trial player. Play/Pause + A/B toggle (labeled only A / B,
// no parameter readout) and the position-pick choice row, mapped to the protocol's
// Pick. Submit disabled while a write is in flight (one row per decision). Audio
// playback is driven by the parent via the AudioController prop so this component is
// unit-testable without Web Audio; terminal/unavailable states arrive as `phase`.

import {type CSSProperties, useEffect, useState} from 'react';
import {bandStyle} from './labStyles';
import type {PendingTrial, Pick} from '../protocol/protocolTypes';
import type {AbSide} from './labAudioPlayer';

export interface AudioController {
    play(): Promise<boolean>; // resolves to whether audio is actually running afterward
    pause(): Promise<void>;
    setActive(side: AbSide): void;
}

export type PlayerPhase =
    | {kind: 'trial'; pending: PendingTrial}
    | {kind: 'sweep-complete'}
    | {kind: 'resample-exhausted'}
    | {kind: 'audio-unavailable'; onResume: () => void};

export interface TrialPlayerBandProps {
    phase: PlayerPhase;
    submitting: boolean;
    onChoose: (pick: Pick) => void;
    audio?: AudioController;
    // Fired when a Play gesture's resume is blocked (autoplay policy); the parent
    // flips into the audio-unavailable phase.
    onAudioUnavailable?: () => void;
}

const btnRow: CSSProperties = {display: 'flex', gap: 12, marginTop: 12};

export function TrialPlayerBand(props: TrialPlayerBandProps) {
    const [playing, setPlaying] = useState(false);
    const [side, setSide] = useState<AbSide>('A');

    // Reset transport state when a new trial arrives. The active trial's pending
    // object is extracted to a variable so the effect dep is statically checkable.
    const activePending = props.phase.kind === 'trial' ? props.phase.pending : null;
    useEffect(() => {
        setPlaying(false);
        setSide('A');
    }, [activePending]);

    if (props.phase.kind === 'sweep-complete') {
        return <div style={bandStyle} data-testid="sweep-complete"><h2>Trial player</h2><p>Sweep complete. Reconfigure for a new session.</p></div>;
    }
    if (props.phase.kind === 'resample-exhausted') {
        return <div style={bandStyle} data-testid="resample-exhausted"><h2>Trial player</h2><p>Random range too constrained: every draw collided. Widen the range and restart.</p></div>;
    }
    if (props.phase.kind === 'audio-unavailable') {
        return (
            <div style={bandStyle} data-testid="audio-unavailable">
                <h2>Trial player</h2>
                <p style={{color: 'crimson'}}>Audio unavailable.</p>
                <button type="button" data-testid="resume-audio" onClick={props.phase.onResume}>Resume audio</button>
            </div>
        );
    }

    const togglePlay = async () => {
        if (playing) {
            await props.audio?.pause();
            setPlaying(false);
        } else {
            const running = await props.audio?.play();
            if (running === false) {
                // Resume blocked by autoplay policy; hand off to the audio-unavailable phase.
                props.onAudioUnavailable?.();

                return;
            }
            setPlaying(true);
        }
    };

    const toggleSide = () => {
        const next: AbSide = side === 'A' ? 'B' : 'A';
        setSide(next);
        props.audio?.setActive(next);
    };

    return (
        <div style={bandStyle} data-testid="player-body">
            <h2>Trial player</h2>
            <div style={btnRow}>
                <button type="button" data-testid="play-pause" onClick={togglePlay}>{playing ? 'Pause' : 'Play'}</button>
                <button type="button" data-testid="ab-toggle" onClick={toggleSide}>Now: {side}</button>
            </div>
            <div style={btnRow}>
                <button type="button" data-testid="choose-a" disabled={props.submitting} onClick={() => props.onChoose('first')}>A rings more</button>
                <button type="button" data-testid="choose-tie" disabled={props.submitting} onClick={() => props.onChoose('tie')}>Tie</button>
                <button type="button" data-testid="choose-b" disabled={props.submitting} onClick={() => props.onChoose('second')}>B rings more</button>
            </div>
        </div>
    );
}
