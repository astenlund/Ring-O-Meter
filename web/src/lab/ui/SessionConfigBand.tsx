// web/src/lab/ui/SessionConfigBand.tsx
// Band 1: assembles a SessionConfig from operator inputs and runs the documented
// pre-checks (confound block/warn, non-monotonic advisory). Does NOT open the
// session; hands the assembled config to the parent so Lab owns store I/O and the
// CalibrationConfigError surface (spec "### Band 1"). erasableSyntaxOnly-safe.

import {type CSSProperties, useMemo, useState} from 'react';
import {buildChord, voiceCountFor, VOWEL_PRESETS, CHORD_QUALITIES, type ChordQuality, type VowelPresetName} from '../synth/chordBuilder';
import {bandStyle} from './labStyles';
import {ALL_SWEEP_AXES, type SessionConfig, type Selector, type SweepAxis} from '../protocol/protocolTypes';
import {NOTE_OPTIONS} from './noteToHz';
import {precheckSelector} from './configGuards';

export interface SessionConfigBandProps {
    listenerId: string;
    disabled: boolean;
    onStart: (config: SessionConfig) => void;
}

const fieldRow: CSSProperties = {display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8};

const PRESET_NAMES = Object.keys(VOWEL_PRESETS) as VowelPresetName[];

export function SessionConfigBand(props: SessionConfigBandProps) {
    const [rootHz, setRootHz] = useState(220);
    const [quality, setQuality] = useState<ChordQuality>('dom7');
    const [presetName, setPresetName] = useState<VowelPresetName>(PRESET_NAMES[0]);
    const [axis, setAxis] = useState<SweepAxis>('fundamental');
    const [targetVoiceIndex, setTargetVoiceIndex] = useState(0);
    const [mode, setMode] = useState<'sweep' | 'random'>('sweep');
    const [deltasText, setDeltasText] = useState('-20,-10,10,20');
    const [repeats, setRepeats] = useState(5);
    const [rangeMin, setRangeMin] = useState(-20);
    const [rangeMax, setRangeMax] = useState(20);

    const voiceCount = voiceCountFor(quality);
    // Re-clamp target voice whenever the quality (voice count) changes.
    const clampedTarget = Math.min(targetVoiceIndex, voiceCount - 1);

    // buildChord throws on a non-positive / non-finite root; clearing the number
    // input yields Number('') === 0, so guard here or the render-time call crashes
    // the band. An invalid root produces a null selector + an inline message.
    const rootValid = Number.isFinite(rootHz) && rootHz > 0;

    const selector: Selector | null = useMemo(() => {
        if (!rootValid) {
            return null;
        }
        const baseline = buildChord(rootHz, quality, VOWEL_PRESETS[presetName]);
        if (mode === 'sweep') {
            const deltas = deltasText.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));

            return {mode: 'sweep', axis, targetVoiceIndex: clampedTarget, baseline, deltas, repeats};
        }

        return {mode: 'random', axis, targetVoiceIndex: clampedTarget, baseline, range: {min: rangeMin, max: rangeMax}};
    }, [rootValid, rootHz, quality, presetName, axis, clampedTarget, mode, deltasText, repeats, rangeMin, rangeMax]);

    const precheck = useMemo(() => (selector ? precheckSelector(selector) : {block: null, warnings: []}), [selector]);

    const start = () => {
        if (!selector || precheck.block) {
            return;
        }
        props.onStart({listenerId: props.listenerId, selector});
    };

    return (
        <div style={bandStyle} data-testid="config-band">
            <h2>Session config</h2>
            <div style={fieldRow}>
                <label>root Hz
                    <input type="number" data-testid="root-hz" value={rootHz} min={1} onChange={(e) => setRootHz(Number(e.target.value))} />
                </label>
                <label>note
                    <select data-testid="note-select" onChange={(e) => { if (e.target.value) { setRootHz(Number(e.target.value)); } }}>
                        <option value="">--</option>
                        {NOTE_OPTIONS.map((o) => <option key={o.label} value={o.hz}>{o.label}</option>)}
                    </select>
                </label>
                <label>quality
                    <select data-testid="quality-select" value={quality} onChange={(e) => setQuality(e.target.value as ChordQuality)}>
                        {CHORD_QUALITIES.map((q) => <option key={q} value={q}>{q}</option>)}
                    </select>
                </label>
                <label>vowel
                    <select data-testid="preset-select" value={presetName} onChange={(e) => setPresetName(e.target.value as VowelPresetName)}>
                        {PRESET_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                </label>
            </div>
            <div style={fieldRow}>
                <label>axis
                    <select data-testid="axis-select" value={axis} onChange={(e) => setAxis(e.target.value as SweepAxis)}>
                        {ALL_SWEEP_AXES.map((a) => <option key={a} value={a}>{a}</option>)}
                    </select>
                </label>
                <label>target voice
                    <select data-testid="target-voice-select" value={clampedTarget} onChange={(e) => setTargetVoiceIndex(Number(e.target.value))}>
                        {Array.from({length: voiceCount}, (_, i) => <option key={i} value={i}>{i === 0 ? '0 (root)' : String(i)}</option>)}
                    </select>
                </label>
                <label>mode
                    <select data-testid="mode-select" value={mode} onChange={(e) => setMode(e.target.value as 'sweep' | 'random')}>
                        <option value="sweep">sweep</option>
                        <option value="random">random</option>
                    </select>
                </label>
            </div>
            {mode === 'sweep' ? (
                <div style={fieldRow}>
                    <label>deltas (comma-separated)
                        <input type="text" data-testid="deltas-input" value={deltasText} onChange={(e) => setDeltasText(e.target.value)} />
                    </label>
                    <label>repeats
                        <input type="number" data-testid="repeats-input" value={repeats} min={1} onChange={(e) => setRepeats(Number(e.target.value))} />
                    </label>
                </div>
            ) : (
                <div style={fieldRow}>
                    <label>range min
                        <input type="number" data-testid="range-min" value={rangeMin} onChange={(e) => setRangeMin(Number(e.target.value))} />
                    </label>
                    <label>range max
                        <input type="number" data-testid="range-max" value={rangeMax} onChange={(e) => setRangeMax(Number(e.target.value))} />
                    </label>
                </div>
            )}
            {!rootValid && <p style={{color: 'crimson'}} data-testid="root-invalid">Enter a positive root frequency.</p>}
            {precheck.block && <p style={{color: 'crimson'}} data-testid="config-block">{precheck.block}</p>}
            {precheck.warnings.map((w, i) => <p key={i} style={{color: '#e0a030'}} data-testid="config-warning">{w}</p>)}
            <button type="button" data-testid="start-session" disabled={props.disabled || selector === null || precheck.block !== null} onClick={start}>
                Start session
            </button>
        </div>
    );
}
