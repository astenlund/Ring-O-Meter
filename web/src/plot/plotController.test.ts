import {describe, expect, it, vi, beforeEach} from 'vitest';
import {PlotController} from './plotController';

// Minimal Worker mock: captures postMessage calls for inspection.
class MockWorker {
    public readonly messages: Array<{msg: unknown; transfer?: unknown[]}> = [];
    public postMessage(msg: unknown, transfer?: unknown[]): void {
        this.messages.push({msg, transfer});
    }
    public terminate(): void {
        // no-op
    }
}

// Minimal OffscreenCanvas stub for jsdom (which has no real OffscreenCanvas).
class MockOffscreenCanvas {
    constructor(public width: number, public height: number) {}
}

describe('PlotController.setChordClassification', () => {
    let controller: PlotController;
    let mockWorker: MockWorker;

    beforeEach(() => {
        mockWorker = new MockWorker();
        const capturedWorker = mockWorker;
        vi.stubGlobal('Worker', class {
            postMessage(msg: unknown, transfer?: unknown[]): void {
                capturedWorker.postMessage(msg, transfer);
            }
            terminate(): void {
                capturedWorker.terminate();
            }
        });
        vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas);
        controller = new PlotController('fake-worker-url');
        // Trigger worker creation via attachChordBarsCanvas so the worker
        // is live before setChordClassification calls post().
        const canvas = new MockOffscreenCanvas(100, 100) as unknown as OffscreenCanvas;
        controller.attachChordBarsCanvas(canvas);
        // Clear the InitChordBarsCanvas message so the assertion counts below
        // cover only the setChordClassification calls.
        mockWorker.messages.length = 0;
    });

    it('reuses the same message object across consecutive calls', () => {
        const residuals = new Float32Array(8).fill(0);

        controller.setChordClassification(1, 'bass', 261.6, residuals);
        controller.setChordClassification(0, 'tenor', 440, residuals);

        expect(mockWorker.messages).toHaveLength(2);

        const first = mockWorker.messages[0].msg;
        const second = mockWorker.messages[1].msg;

        // Both calls must post the exact same object reference.
        expect(first).toBe(second);
    });

    it('updates the message fields on each call', () => {
        const residuals = new Float32Array(8).fill(0);

        controller.setChordClassification(1, 'bass', 261.6, residuals);
        controller.setChordClassification(null, null, 0, residuals);

        // After the second call the shared object reflects the latest values.
        const msg = mockWorker.messages[1].msg as {
            lockedChordType: number | null;
            rootChannelId: string | null;
            rootHz: number;
        };
        expect(msg.lockedChordType).toBeNull();
        expect(msg.rootChannelId).toBeNull();
        expect(msg.rootHz).toBe(0);
    });
});
