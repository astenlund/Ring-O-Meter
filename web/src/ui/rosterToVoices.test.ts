import {describe, expect, it} from 'vitest';
import {slotsToVoices, type SlotRosterEntry} from './rosterToVoices';

describe('slotsToVoices', () => {
    it('translates deviceLabel into the VoiceEntry label field', () => {
        // Arrange
        const slots: ReadonlyArray<SlotRosterEntry> = [
            {channelId: 'ch-a', deviceLabel: 'Mic A', color: '#5cf'},
            {channelId: 'ch-b', deviceLabel: 'Mic B', color: '#fc5'},
        ];

        // Act
        const voices = slotsToVoices(slots);

        // Assert
        expect(voices).toEqual([
            {channelId: 'ch-a', label: 'Mic A', color: '#5cf'},
            {channelId: 'ch-b', label: 'Mic B', color: '#fc5'},
        ]);
    });

    it('preserves slot order in the output', () => {
        // Arrange
        const slots: ReadonlyArray<SlotRosterEntry> = [
            {channelId: 'second', deviceLabel: 'B', color: '#fc5'},
            {channelId: 'first', deviceLabel: 'A', color: '#5cf'},
        ];

        // Act
        const voices = slotsToVoices(slots);

        // Assert
        expect(voices.map((v) => v.channelId)).toEqual(['second', 'first']);
    });

    it('returns an empty array for an empty roster', () => {
        // Arrange / Act / Assert
        expect(slotsToVoices([])).toEqual([]);
    });
});
