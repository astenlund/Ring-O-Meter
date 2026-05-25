// Stateful calibration session. Owns one continuous mulberry32 stream so a fixed
// seed makes the whole trial sequence reproducible. Draw order per trial:
// value-pair (random only, incl. resample redraws), then A/B-label assignment,
// then presentation order, then seedA, then seedB.

import {mulberry32, type Rng} from '../synth/seededRng';
import type {ChordParams} from '../synth/voiceParams';
import {makeCalibrationTrial, type NewTrialInput, type TrialChoice} from '../store/calibrationTrial';
import type {CalibrationStore} from '../store/calibrationStore';
import {applyAxisDelta} from './axisTransform';
import {formantCollides} from './coincidence';
import {ResampleExhaustedError, type PendingTrial, type Pick, type SessionConfig, type SweepAxis} from './protocolTypes';
import {assignLabels, axisIsTuning, choosePresentationOrder, drawSeed, MAX_RESAMPLE_ATTEMPTS, validateConfig} from './trialGen';

export interface CalibrationSession {
    readonly sessionId: string;
    readonly listenerId: string;
    nextTrial(): PendingTrial | null;
    recordChoice(pending: PendingTrial, pick: Pick): Promise<void>;
}

export function openCalibrationSession(store: CalibrationStore, config: SessionConfig): CalibrationSession {
    validateConfig(config); // no store I/O; an unavailable store surfaces at recordChoice.

    const sessionId = crypto.randomUUID();
    const listenerId = config.listenerId;
    const seed = config.seed ?? (Math.floor(Math.random() * 2 ** 32) >>> 0);
    const rng: Rng = mulberry32(seed);
    const sel = config.selector;

    let sweepIndex = 0;

    function finishTrial(variant0: ChordParams, variant1: ChordParams, delta: number, axis: SweepAxis | null): PendingTrial {
        // RNG draw order is a reproducibility contract (see file header): label
        // assignment, then presentation order, then seedA, then seedB. Any
        // value-pair draws (random mode) happen before this. Do not reorder.
        const {chordA, chordB, sweepDelta} = assignLabels(rng, variant0, variant1, delta);
        const presentationOrder = choosePresentationOrder(rng);
        const seedA = drawSeed(rng);
        const seedB = drawSeed(rng);

        return {
            sessionId,
            listenerId,
            selectorMode: sel.mode,
            sweepAxis: axis,
            sweepDelta: axis === null ? null : sweepDelta,
            chordA,
            chordB,
            seedA,
            seedB,
            presentationOrder,
        };
    }

    function nextSweep(): PendingTrial | null {
        if (sel.mode !== 'sweep') {
            return null;
        }

        const total = sel.deltas.length * sel.repeats;
        if (sweepIndex >= total) {
            return null;
        }

        const delta = sel.deltas[sweepIndex % sel.deltas.length];
        sweepIndex += 1;
        const variant0 = sel.baseline;
        const variant1 = applyAxisDelta(sel.baseline, sel.axis, sel.targetVoiceIndex, delta);

        return finishTrial(variant0, variant1, delta, sel.axis);
    }

    function nextRandom(): PendingTrial {
        if (sel.mode !== 'random') {
            throw new Error('nextRandom called in non-random mode');
        }

        const check = axisIsTuning(sel.axis);
        for (let attempt = 0; attempt < MAX_RESAMPLE_ATTEMPTS; attempt++) {
            const span = sel.range.max - sel.range.min;
            const dA = sel.range.min + rng() * span;
            const dB = sel.range.min + rng() * span;
            const variant0 = applyAxisDelta(sel.baseline, sel.axis, sel.targetVoiceIndex, dA);
            const variant1 = applyAxisDelta(sel.baseline, sel.axis, sel.targetVoiceIndex, dB);
            if (check && (formantCollides(variant0) || formantCollides(variant1))) {
                continue;
            }

            // delta is unused for random rows (sweepDelta null), pass 0 as placeholder.
            return finishTrial(variant0, variant1, 0, null);
        }

        throw new ResampleExhaustedError(`Random range too constrained: ${MAX_RESAMPLE_ATTEMPTS} attempts all collided.`);
    }

    function nextTrial(): PendingTrial | null {
        switch (sel.mode) {
            case 'sweep':
                return nextSweep();
            case 'random':
                return nextRandom();
            default: {
                const _exhaustive: never = sel;

                return _exhaustive;
            }
        }
    }

    async function recordChoice(pending: PendingTrial, pick: Pick): Promise<void> {
        let choice: TrialChoice;
        if (pick === 'tie') {
            choice = 'tie';
        } else {
            choice = pending.presentationOrder[pick === 'first' ? 0 : 1];
        }

        const input: NewTrialInput = {
            trialId: crypto.randomUUID(),
            sessionId: pending.sessionId,
            listenerId: pending.listenerId,
            selectorMode: pending.selectorMode,
            sweepAxis: pending.sweepAxis,
            sweepDelta: pending.sweepDelta,
            chordA: pending.chordA,
            chordB: pending.chordB,
            seedA: pending.seedA,
            seedB: pending.seedB,
            choice,
            timestampMs: Date.now(),
            isSanityTrial: false,
        };

        await store.addTrial(makeCalibrationTrial(input));
    }

    return {sessionId, listenerId, nextTrial, recordChoice};
}
