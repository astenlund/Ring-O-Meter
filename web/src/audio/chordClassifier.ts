import {CHORD_HYPOTHESES, ALL_CHORD_TYPES, ChordType, type ChordIdentity}
    from '../wire/chord';
import {octaveReducedCents} from './octaveCents';

export interface VoiceObservation {
    readonly channelId: string;
    readonly f0Hz: number;
    readonly slotIndex: number;
    readonly gateOpen: boolean;
}

export interface ClassifierResult {
    readonly lockedChord: ChordIdentity | null;
    readonly residualsPerVoice: ReadonlyMap<string, number>;
}

// heuristic: sanity-threshold-per-nonroot-voice-cents
const SANITY_PER_NONROOT_VOICE_CENTS = 25;

const EMPTY_RESIDUALS: ReadonlyMap<string, number> = new Map();
const NO_CHORD: ClassifierResult = Object.freeze({
    lockedChord: null,
    residualsPerVoice: EMPTY_RESIDUALS,
});

// Module-scoped scratch buffer per hot-path-allocation-discipline.
// Sized to MAX_VOICES = 8. Holds octave-reduced cents for non-root voices
// during the residuals pass.
const _activeCents = new Float64Array(8);

// Reusable residuals map; cleared and refilled on each call so the
// Map object itself is not allocated in steady state.
const _residualsMap = new Map<string, number>();

export function classifyChord(voices: ReadonlyArray<VoiceObservation>): ClassifierResult {
    // Step 1: collect active voices (gate + finite positive Hz).
    // Acceptable local array allocation per the plan note: "Map/result
    // allocation is acceptable for now; the alloc test in Task 13 will
    // measure it precisely."
    const active: VoiceObservation[] = [];
    for (const v of voices) {
        if (v.gateOpen && Number.isFinite(v.f0Hz) && v.f0Hz > 0) {
            active.push(v);
        }
    }

    if (active.length < 3) {
        return NO_CHORD;
    }

    let bestSum = Number.POSITIVE_INFINITY;
    let bestRootIdx = -1;
    let bestType: ChordType | null = null;

    // Step 2: enumerate (hypothesis, candidate-root) pairs in declaration
    // order so the tie-break rule (lower ChordType enum index, then lower
    // active-voice index) is satisfied by iteration order.
    for (const type of ALL_CHORD_TYPES) {
        const hyp = CHORD_HYPOTHESES[type];
        // Hypotheses with minArity > N are excluded from the loop entirely
        // (not merely outscored). This is why 3 voices cannot lock as dom7.
        if (hyp.minArity > active.length) {
            continue;
        }

        for (let rootIdx = 0; rootIdx < active.length; rootIdx++) {
            const root = active[rootIdx];
            let sum = 0;

            for (let i = 0; i < active.length; i++) {
                if (i === rootIdx) {
                    continue;
                }
                const cents = octaveReducedCents(active[i].f0Hz, root.f0Hz);
                // Find closest JI target in the hypothesis's ratio table.
                let closestDiff = Infinity;
                for (const target of hyp.targetCents) {
                    const diff = Math.abs(cents - target);
                    if (diff < closestDiff) {
                        closestDiff = diff;
                    }
                }
                sum += closestDiff;
            }

            // Step 3 tie-break: strictly less than replaces; equal does not.
            // This naturally enforces (a) lower ChordType index wins (outer
            // loop order), then (b) lower active-voice index wins (inner loop
            // order), because we only update on strict improvement.
            if (sum < bestSum) {
                bestSum = sum;
                bestRootIdx = rootIdx;
                bestType = type;
            }
        }
    }

    if (bestType === null || bestRootIdx === -1) {
        return NO_CHORD;
    }

    // Step 3 sanity threshold: 25¢ × number of non-root voices.
    const threshold = SANITY_PER_NONROOT_VOICE_CENTS * (active.length - 1);
    if (bestSum > threshold) {
        return NO_CHORD;
    }

    // Step 5: compute per-voice residuals (signed: positive = sharp).
    // Reuse _activeCents scratch to avoid recomputing octaveReducedCents.
    const root = active[bestRootIdx];
    const hyp = CHORD_HYPOTHESES[bestType];

    for (let i = 0; i < active.length; i++) {
        _activeCents[i] = (i === bestRootIdx)
            ? 0
            : octaveReducedCents(active[i].f0Hz, root.f0Hz);
    }

    _residualsMap.clear();
    _residualsMap.set(root.channelId, 0);

    for (let i = 0; i < active.length; i++) {
        if (i === bestRootIdx) {
            continue;
        }
        const cents = _activeCents[i];
        let closestTarget = hyp.targetCents[0];
        let closestDiff = Math.abs(cents - closestTarget);
        for (const target of hyp.targetCents) {
            const diff = Math.abs(cents - target);
            if (diff < closestDiff) {
                closestDiff = diff;
                closestTarget = target;
            }
        }
        _residualsMap.set(active[i].channelId, cents - closestTarget);
    }

    // Snapshot copy: _residualsMap is module-scoped scratch that the
    // next classifyChord call will .clear() and re-fill. Returning it
    // by reference would silently invalidate any held ClassifierResult
    // (ChordHysteresis.locked/.candidate, React state). Per the plan's
    // note, this allocation is acceptable; the alloc test measures it.
    return {
        lockedChord: {type: bestType, rootChannelId: root.channelId, rootHz: root.f0Hz},
        residualsPerVoice: new Map(_residualsMap),
    };
}
