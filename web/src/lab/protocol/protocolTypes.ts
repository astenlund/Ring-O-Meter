// Types for the headless calibration protocol module. erasableSyntaxOnly: string
// unions (no enums), plain classes (no constructor parameter properties).

import type {ChordParams} from '../synth/voiceParams';
import type {SelectorMode} from '../store/calibrationTrial';

// Canonical per-dimension sweep namespace, derived from the seven synthesis
// dimensions in spec section "## Synthesis engine". Compound dimensions split
// into distinct entries. The module is the single source of truth for these
// strings; the store persists them as opaque `sweepAxis` values.
export type SweepAxis =
    | 'fundamental'
    | 'harmonicRichness'
    | 'formant.f1'
    | 'formant.f2'
    | 'pitchVariance.drift'
    | 'pitchVariance.jitter'
    | 'vibrato.rate'
    | 'vibrato.depth'
    | 'envelope.attack'
    | 'envelope.sustain'
    | 'envelope.release'
    | 'onset';

// Runtime registry of valid axis strings: the SweepAxis union is erased at
// runtime (erasableSyntaxOnly), so config validation needs a runtime value list.
// Deriving it from a `satisfies Record<SweepAxis, true>` makes the compiler reject
// any drift from the union - adding an axis to SweepAxis but omitting it here (or
// vice versa) is a compile error, not a silent runtime "unknown axis" rejection.
// The per-axis apply-mode is the axisTransform switch's single source of truth;
// native units are documented in the spec, not duplicated here.
const SWEEP_AXIS_SET = {
    fundamental: true,
    harmonicRichness: true,
    'formant.f1': true,
    'formant.f2': true,
    'pitchVariance.drift': true,
    'pitchVariance.jitter': true,
    'vibrato.rate': true,
    'vibrato.depth': true,
    'envelope.attack': true,
    'envelope.sustain': true,
    'envelope.release': true,
    onset: true,
} satisfies Record<SweepAxis, true>;

export const ALL_SWEEP_AXES = Object.keys(SWEEP_AXIS_SET) as SweepAxis[];

export interface SweepSelector {
    mode: 'sweep';
    axis: SweepAxis;
    targetVoiceIndex: number;
    baseline: ChordParams;
    deltas: number[];
    repeats: number;
}

export interface RandomSelector {
    mode: 'random';
    axis: SweepAxis;
    targetVoiceIndex: number;
    baseline: ChordParams;
    range: {min: number; max: number};
}

export type Selector = SweepSelector | RandomSelector;

export interface SessionConfig {
    listenerId: string;
    seed?: number;
    selector: Selector;
}

export interface PendingTrial {
    sessionId: string;
    listenerId: string;
    selectorMode: SelectorMode;
    sweepAxis: SweepAxis | null;
    sweepDelta: number | null;
    chordA: ChordParams;
    chordB: ChordParams;
    seedA: number;
    seedB: number;
    presentationOrder: ['A', 'B'] | ['B', 'A'];
}

export type Pick = 'first' | 'second' | 'tie';

// Thrown by openCalibrationSession on invalid config.
export class CalibrationConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CalibrationConfigError';
    }
}

// Thrown synchronously by nextTrial when random-mode resampling hits the cap.
export class ResampleExhaustedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ResampleExhaustedError';
    }
}
