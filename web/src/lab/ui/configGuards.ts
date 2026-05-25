// Band 1 pre-checks over the shipped confound check + axis transform. A confound
// collision (a non-test control formant on a partial-coincidence frequency) blocks
// Start in sweep mode (mirrors the module's fail-fast) and warns in random mode
// (the module reject-resamples). A non-monotonic-axis selection produces an
// advisory warning only (spec section "### Band 1"). This module computes nothing
// about peak location; it flags the axis and lets the operator restrict the range.

import {applyAxisDelta} from '../protocol/axisTransform';
import {formantCollides} from '../protocol/coincidence';
import type {Selector, SweepAxis} from '../protocol/protocolTypes';

// heuristic: axes whose ring preference peaks (non-monotonic), so a sweep
// straddling the peak reads as "no effect" rather than the real signal.
export const NON_MONOTONIC_AXES: readonly SweepAxis[] = ['vibrato.depth', 'formant.f1', 'formant.f2', 'harmonicRichness'];

export function isNonMonotonicAxis(axis: SweepAxis): boolean {
    return NON_MONOTONIC_AXES.includes(axis);
}

export interface PrecheckResult {
    block: string | null;
    warnings: string[];
}

// True when the baseline or any swept variant of the target voice collides.
function anyVariantCollides(selector: Selector): boolean {
    if (formantCollides(selector.baseline)) {
        return true;
    }

    if (selector.mode === 'sweep') {
        for (const delta of selector.deltas) {
            if (formantCollides(applyAxisDelta(selector.baseline, selector.axis, selector.targetVoiceIndex, delta))) {
                return true;
            }
        }
    }

    return false;
}

export function precheckSelector(selector: Selector): PrecheckResult {
    const warnings: string[] = [];
    let block: string | null = null;

    const collides = anyVariantCollides(selector);
    if (collides) {
        const msg = `confound risk: a control formant sits on a partial-coincidence frequency for this chord (axis "${selector.axis}").`;
        if (selector.mode === 'sweep') {
            block = msg + ' Choose a vowel preset whose formants sit away from the coincidences, or change the chord.';
        } else {
            warnings.push(msg + ' Random mode will reject-and-resample colliding draws, but the range may be hard to satisfy.');
        }
    }

    if (isNonMonotonicAxis(selector.axis)) {
        warnings.push(`Non-monotonic axis "${selector.axis}": preference peaks across this axis, so a range straddling the peak reads as "no effect". Restrict the range to one side of the peak.`);
    }

    return {block, warnings};
}
