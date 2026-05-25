import {describe, it, expect} from 'vitest';
import {precheckSelector, isNonMonotonicAxis, NON_MONOTONIC_AXES} from './configGuards';
import {buildChord, VOWEL_PRESETS} from '../synth/chordBuilder';
import type {RandomSelector, SweepSelector} from '../protocol/protocolTypes';

const baseline = buildChord(220, 'dom7', VOWEL_PRESETS.schwa);

function sweep(over: Partial<SweepSelector> = {}): SweepSelector {
    return {mode: 'sweep', axis: 'fundamental', targetVoiceIndex: 0, baseline, deltas: [-10, 10], repeats: 2, ...over};
}

function random(over: Partial<RandomSelector> = {}): RandomSelector {
    return {mode: 'random', axis: 'fundamental', targetVoiceIndex: 0, baseline, range: {min: -20, max: 20}, ...over};
}

describe('isNonMonotonicAxis', () => {
    it('flags the four known peaked axes and nothing else', () => {
        // Arrange / Act / Assert
        for (const a of NON_MONOTONIC_AXES) {
            expect(isNonMonotonicAxis(a)).toBe(true);
        }
        expect(isNonMonotonicAxis('fundamental')).toBe(false);
        expect(isNonMonotonicAxis('onset')).toBe(false);
    });
});

describe('precheckSelector', () => {
    it('passes a clean fundamental sweep with no block and no warnings', () => {
        // Arrange / Act
        const result = precheckSelector(sweep());

        // Assert
        expect(result.block).toBeNull();
        expect(result.warnings).toHaveLength(0);
    });

    it('blocks a sweep whose baseline formant collides with a coincidence', () => {
        // Arrange: 1100 Hz is the voice0-5th / voice1-4th partial coincidence for a JI dom7 at root 220, so an f1 placed there collides deterministically.
        const colliding = buildChord(220, 'dom7', {f1Hz: 1100, f2Hz: 1500, partialAmplitudes: VOWEL_PRESETS.schwa.partialAmplitudes});

        // Act
        const result = precheckSelector(sweep({baseline: colliding}));

        // Assert
        expect(result.block).not.toBeNull();
        expect(result.block).toContain('confound');
    });

    it('warns (does not block) on a colliding baseline in random mode', () => {
        // Arrange
        const colliding = buildChord(220, 'dom7', {f1Hz: 1100, f2Hz: 1500, partialAmplitudes: VOWEL_PRESETS.schwa.partialAmplitudes});

        // Act
        const result = precheckSelector(random({baseline: colliding}));

        // Assert
        expect(result.block).toBeNull();
        expect(result.warnings.some((w) => w.toLowerCase().includes('confound'))).toBe(true);
    });

    it('adds a non-monotonic advisory warning for vibrato.depth without blocking', () => {
        // Arrange / Act
        const result = precheckSelector(sweep({axis: 'vibrato.depth'}));

        // Assert
        expect(result.block).toBeNull();
        expect(result.warnings.some((w) => w.toLowerCase().includes('non-monotonic'))).toBe(true);
    });
});
