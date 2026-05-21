import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChordLabel, type ChordLabelProps} from './ChordLabel';
import {ChordType} from '../wire/chord';

let container: HTMLDivElement;
let root: Root;

function renderLabel(props: ChordLabelProps) {
    flushSync(() => {
        root.render(<ChordLabel {...props} />);
    });
}

// C4 = MIDI 60, rootHz ≈ 261.63
const C4_HZ = 440 * Math.pow(2, (60 - 69) / 12);
const ROOT_CHANNEL = 'ch-root';

describe('ChordLabel', () => {
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => {
            root.unmount();
        });
        container.remove();
    });

    it('renders "C" for a Major chord rooted at C4', () => {
        // Arrange / Act
        renderLabel({chord: {type: ChordType.Major, rootChannelId: ROOT_CHANNEL, rootHz: C4_HZ}});

        // Assert
        expect(container.textContent).toBe('C');
    });

    it('renders "C7" for a DominantSeventh chord rooted at C4', () => {
        // Arrange / Act
        renderLabel({chord: {type: ChordType.DominantSeventh, rootChannelId: ROOT_CHANNEL, rootHz: C4_HZ}});

        // Assert
        expect(container.textContent).toBe('C7');
    });

    it('renders "Cm" for a Minor chord rooted at C4', () => {
        // Arrange / Act
        renderLabel({chord: {type: ChordType.Minor, rootChannelId: ROOT_CHANNEL, rootHz: C4_HZ}});

        // Assert
        expect(container.textContent).toBe('Cm');
    });

    it('renders "Cdim" for a Diminished chord rooted at C4', () => {
        // Arrange / Act
        renderLabel({chord: {type: ChordType.Diminished, rootChannelId: ROOT_CHANNEL, rootHz: C4_HZ}});

        // Assert
        expect(container.textContent).toBe('Cdim');
    });

    it('renders "Cm7" for a MinorSeventh chord rooted at C4', () => {
        // Arrange / Act
        renderLabel({chord: {type: ChordType.MinorSeventh, rootChannelId: ROOT_CHANNEL, rootHz: C4_HZ}});

        // Assert
        expect(container.textContent).toBe('Cm7');
    });

    it('renders "A7" for a DominantSeventh chord rooted at A4 (440 Hz)', () => {
        // Arrange / Act
        renderLabel({chord: {type: ChordType.DominantSeventh, rootChannelId: ROOT_CHANNEL, rootHz: 440}});

        // Assert
        expect(container.textContent).toBe('A7');
    });

    it('renders nothing for chord null', () => {
        // Arrange / Act
        renderLabel({chord: null});

        // Assert
        expect(container.innerHTML).toBe('');
    });
});
