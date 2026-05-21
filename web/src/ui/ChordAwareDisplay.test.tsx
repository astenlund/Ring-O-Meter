import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {createRoot, type Root} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ChordAwareDisplay, type ChordAwareDisplayProps} from './ChordAwareDisplay';
import {ChordType} from '../wire/chord';

// Stub ResizeObserver (not provided in jsdom).
const observeSpy = vi.fn();
const disconnectSpy = vi.fn();
class FakeResizeObserver {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
    }
    observe(target: Element) {
        observeSpy(target);
        // Fire immediately with a synthetic entry so callers can verify the callback path.
        this.cb(
            [{
                target,
                contentBoxSize: [{inlineSize: 300, blockSize: 200}],
                borderBoxSize: [],
                devicePixelContentBoxSize: [],
                contentRect: new DOMRect(),
            }],
            this as unknown as ResizeObserver,
        );
    }
    disconnect() {
        disconnectSpy();
    }
}
vi.stubGlobal('ResizeObserver', FakeResizeObserver);

// Stub window.matchMedia (not provided in jsdom). useCanvasBacking
// registers a (resolution: Ndppx) listener for DPR rearm; the hook's
// behavior under DPR change is covered in useCanvasBacking.browser.tsx,
// so this jsdom stub only needs to satisfy the API surface.
vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: false,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
}));

const C4_HZ = 440 * Math.pow(2, (60 - 69) / 12);

const VOICES: ChordAwareDisplayProps['voices'] = [
    {channelId: 'bass', deviceLabel: 'Bass Mic', color: '#ff0000'},
    {channelId: 'bari', deviceLabel: 'Bari Mic', color: '#00ff00'},
    {channelId: 'lead', deviceLabel: 'Lead Mic', color: '#0000ff'},
    {channelId: 'tnr', deviceLabel: 'Tenor Mic', color: '#ffff00'},
];

const DOM7_CHORD = {
    type: ChordType.DominantSeventh,
    rootChannelId: 'bass',
    rootHz: C4_HZ,
};

const ZERO_RESIDUALS: ReadonlyMap<string, number> = new Map([
    ['bass', 0],
    ['bari', 0],
    ['lead', 0],
    ['tnr', 0],
]);

let container: HTMLDivElement;
let root: Root;

function renderDisplay(props: ChordAwareDisplayProps) {
    flushSync(() => {
        root.render(<ChordAwareDisplay {...props} />);
    });
}

describe('ChordAwareDisplay', () => {
    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        observeSpy.mockClear();
        disconnectSpy.mockClear();
    });

    afterEach(() => {
        flushSync(() => {
            root.unmount();
        });
        container.remove();
    });

    it('sets data-chord-type to DominantSeventh (1) when chord is locked dom7', () => {
        // Arrange / Act
        renderDisplay({
            chord: DOM7_CHORD,
            voices: VOICES,
            residualsPerVoice: ZERO_RESIDUALS,
            ringState: 'green',
            onCanvasRef: () => undefined,
            onBackingChange: () => undefined,
        });

        // Assert
        const root = container.firstElementChild as HTMLElement;
        expect(root.dataset['chordType']).toBe('1');
    });

    it('renders data-voice-id and data-cents attributes for each voice', () => {
        // Arrange / Act
        renderDisplay({
            chord: DOM7_CHORD,
            voices: VOICES,
            residualsPerVoice: ZERO_RESIDUALS,
            ringState: 'green',
            onCanvasRef: () => undefined,
            onBackingChange: () => undefined,
        });

        // Assert
        for (const {channelId} of VOICES) {
            const el = container.querySelector(`[data-voice-id="${channelId}"]`) as HTMLElement | null;
            expect(el, `element for ${channelId}`).not.toBeNull();
            expect(el!.dataset['cents']).toBe('0');
        }
    });

    it('invokes onCanvasRef with the canvas element on mount', () => {
        // Arrange
        const onCanvasRef = vi.fn<(canvas: HTMLCanvasElement | null) => void>();

        // Act
        renderDisplay({
            chord: DOM7_CHORD,
            voices: VOICES,
            residualsPerVoice: ZERO_RESIDUALS,
            ringState: null,
            onCanvasRef,
            onBackingChange: () => undefined,
        });

        // Assert: called with a non-null canvas
        expect(onCanvasRef).toHaveBeenCalledWith(expect.any(HTMLCanvasElement));
    });

    it('invokes onBackingChange via ResizeObserver on mount', () => {
        // Arrange
        const onBackingChange = vi.fn<(cssWidth: number, cssHeight: number, dpr: number) => void>();

        // Act
        renderDisplay({
            chord: DOM7_CHORD,
            voices: VOICES,
            residualsPerVoice: ZERO_RESIDUALS,
            ringState: null,
            onCanvasRef: () => undefined,
            onBackingChange,
        });

        // Assert: called with the stub's synthetic size
        expect(onBackingChange).toHaveBeenCalledWith(300, 200, expect.any(Number));
    });

    it('sets data-chord-type to null and hides label and indicator when chord is null', () => {
        // Arrange / Act
        renderDisplay({
            chord: null,
            voices: VOICES,
            residualsPerVoice: new Map(),
            ringState: null,
            onCanvasRef: () => undefined,
            onBackingChange: () => undefined,
        });

        // Assert: data-chord-type attribute is absent when chord is null
        // (React omits attributes set to null entirely)
        const rootEl = container.firstElementChild as HTMLElement;
        expect(rootEl.hasAttribute('data-chord-type')).toBe(false);

        // Assert: chord label renders nothing (ChordLabel returns null for null chord)
        expect(container.querySelector('span')).toBeNull();

        // Assert: ring indicator renders nothing (RingIndicatorDot returns null for null state)
        expect(container.querySelector('[aria-label^="ring-"]')).toBeNull();
    });

    it('renders data-voice-id elements even when chord is null', () => {
        // Arrange / Act
        renderDisplay({
            chord: null,
            voices: VOICES,
            residualsPerVoice: new Map(),
            ringState: null,
            onCanvasRef: () => undefined,
            onBackingChange: () => undefined,
        });

        // Assert: all voice rows are present
        for (const {channelId} of VOICES) {
            const el = container.querySelector(`[data-voice-id="${channelId}"]`);
            expect(el, `element for ${channelId}`).not.toBeNull();
        }
    });

    it('omits data-cents attribute when residual is absent for a voice', () => {
        // Arrange / Act
        renderDisplay({
            chord: null,
            voices: VOICES,
            residualsPerVoice: new Map(),
            ringState: null,
            onCanvasRef: () => undefined,
            onBackingChange: () => undefined,
        });

        // Assert: data-cents is absent (not an empty string) for all voices
        for (const {channelId} of VOICES) {
            const el = container.querySelector(`[data-voice-id="${channelId}"]`) as HTMLElement;
            expect(el.hasAttribute('data-cents')).toBe(false);
        }
    });
});
