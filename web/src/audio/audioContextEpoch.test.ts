import {afterEach, describe, expect, it, vi} from 'vitest';
import {
    AudioContextEpoch,
    REBASE_THRESHOLD_MS,
    type RebaseAudioContext,
} from './audioContextEpoch';

// Minimal AudioContext stub. Only the four members RebaseAudioContext
// names are exercised; 'statechange' is the only event type the epoch
// subscribes to, so the listener registry is keyed by that string.
class FakeAudioContext {
    public currentTime = 0;
    public state: AudioContextState = 'suspended';
    private readonly handlers = new Set<EventListener>();

    public addEventListener(type: string, handler: EventListener): void {
        if (type !== 'statechange') {
            return;
        }
        this.handlers.add(handler);
    }

    public removeEventListener(type: string, handler: EventListener): void {
        if (type !== 'statechange') {
            return;
        }
        this.handlers.delete(handler);
    }

    public dispatchStatechange(): void {
        for (const h of this.handlers) {
            h(new Event('statechange'));
        }
    }

    public get listenerCount(): number {
        return this.handlers.size;
    }
}

interface FakeContextHandle {
    fake: FakeAudioContext;
    asContext: RebaseAudioContext;
}

function createFake(): FakeContextHandle {
    const fake = new FakeAudioContext();

    return {fake, asContext: fake as unknown as RebaseAudioContext};
}

describe('AudioContextEpoch', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('captureInitialOffset() returns the suspended-time placeholder offset without arming a listener', () => {
        // Arrange
        const {fake, asContext} = createFake();
        vi.spyOn(performance, 'now').mockReturnValue(1_000);
        fake.currentTime = 0;
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});

        // Act
        const initial = epoch.captureInitialOffset();

        // Assert (offset capture is pure read; arm() is the side-effecting call)
        expect(initial).toBe(1_000); // 1000 - 0*1000
        expect(fake.listenerCount).toBe(0);
        expect(onRebase).not.toHaveBeenCalled();
        expect(epoch.rebaseCount).toBe(0);
    });

    it('arm() attaches exactly one statechange listener', () => {
        // Arrange
        const {fake, asContext} = createFake();
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();

        // Act
        epoch.arm();

        // Assert
        expect(fake.listenerCount).toBe(1);
        expect(onRebase).not.toHaveBeenCalled();
    });

    it('fires onRebase on the first running transition even when offset delta is zero', () => {
        // Arrange (capture perfNow=1000, currentTime=0 -> placeholder offset 1000)
        const {fake, asContext} = createFake();
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(1_000);
        fake.currentTime = 0;
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();
        epoch.arm();

        // Act (handleStateChange recomputes the offset; with perfNow=1000
        // and currentTime=0 the delta is exactly zero)
        nowSpy.mockReturnValue(1_000);
        fake.state = 'running';
        fake.dispatchStatechange();

        // Assert (first running unconditionally fires regardless of delta)
        expect(onRebase).toHaveBeenCalledTimes(1);
        expect(onRebase).toHaveBeenLastCalledWith(1_000);
        expect(epoch.rebaseCount).toBe(1);
    });

    it('does not synthesize a rebase when arm() is called against an already-running context', () => {
        // Arrange (the listener-only mechanism implies the first-running
        // contract only fires on a transition; pre-existing 'running'
        // state at arm() time is missed by design)
        const {fake, asContext} = createFake();
        vi.spyOn(performance, 'now').mockReturnValue(0);
        fake.currentTime = 0;
        fake.state = 'running';
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();

        // Act
        epoch.arm();

        // Assert (no synthetic catch-up)
        expect(onRebase).not.toHaveBeenCalled();
        expect(epoch.rebaseCount).toBe(0);

        // Act 2 (a redundant statechange dispatch now flips through the
        // first-running rule normally)
        fake.dispatchStatechange();

        // Assert
        expect(onRebase).toHaveBeenCalledTimes(1);
        expect(epoch.rebaseCount).toBe(1);
    });

    it('throws when arm() is called twice', () => {
        // Arrange
        const {asContext} = createFake();
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();
        epoch.arm();

        // Act / Assert (second arm must not silently leak a listener)
        expect(() => epoch.arm()).toThrowError(/twice/);
    });

    it('does not fire on subsequent running transitions with sub-threshold drift', () => {
        // Arrange (anchor a real running offset of 0)
        const {fake, asContext} = createFake();
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
        fake.currentTime = 0;
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();
        epoch.arm();
        fake.state = 'running';
        fake.dispatchStatechange(); // first running -> fires (offset 0)
        onRebase.mockClear();

        // Act (drift smaller than the threshold: perfNow advances by 0.5ms,
        // currentTime stays 0 -> new offset 0.5, |0.5 - 0| = 0.5 < 1)
        nowSpy.mockReturnValue(REBASE_THRESHOLD_MS / 2);
        fake.dispatchStatechange();

        // Assert
        expect(onRebase).not.toHaveBeenCalled();
        expect(epoch.rebaseCount).toBe(1);
    });

    it('does not fire on the boundary delta exactly equal to the threshold', () => {
        // Arrange (the predicate is `> threshold`, so equal is below the bar)
        const {fake, asContext} = createFake();
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
        fake.currentTime = 0;
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();
        epoch.arm();
        fake.state = 'running';
        fake.dispatchStatechange();
        onRebase.mockClear();

        // Act
        nowSpy.mockReturnValue(REBASE_THRESHOLD_MS);
        fake.dispatchStatechange();

        // Assert
        expect(onRebase).not.toHaveBeenCalled();
    });

    it('fires on subsequent running transitions when drift exceeds the threshold', () => {
        // Arrange (anchor offset 0)
        const {fake, asContext} = createFake();
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
        fake.currentTime = 0;
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();
        epoch.arm();
        fake.state = 'running';
        fake.dispatchStatechange();
        onRebase.mockClear();

        // Act (suspend/resume opens a wide gap: perfNow jumps 50ms while
        // currentTime stays put, simulating frozen-during-suspend audio
        // clock vs. wall-clock perf advance)
        nowSpy.mockReturnValue(50);
        fake.state = 'suspended';
        fake.dispatchStatechange(); // suspended is a no-op
        fake.state = 'running';
        fake.dispatchStatechange();

        // Assert (the new offset is 50, well above threshold)
        expect(onRebase).toHaveBeenCalledTimes(1);
        expect(onRebase).toHaveBeenLastCalledWith(50);
        expect(epoch.rebaseCount).toBe(2);
    });

    it('updates the propagated baseline so the next sub-threshold drift is measured from the new anchor', () => {
        // Arrange
        const {fake, asContext} = createFake();
        const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(0);
        fake.currentTime = 0;
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();
        epoch.arm();
        fake.state = 'running';
        fake.dispatchStatechange(); // anchor at offset 0
        nowSpy.mockReturnValue(50);
        fake.dispatchStatechange(); // moves baseline to 50
        onRebase.mockClear();

        // Act (drift of 0.5ms from new baseline; would have been > threshold
        // from the original baseline of 0 had the rebase not updated it)
        nowSpy.mockReturnValue(50 + REBASE_THRESHOLD_MS / 2);
        fake.dispatchStatechange();

        // Assert
        expect(onRebase).not.toHaveBeenCalled();
        expect(epoch.rebaseCount).toBe(2);
    });

    it('treats suspended and closed transitions as no-ops', () => {
        // Arrange
        const {fake, asContext} = createFake();
        vi.spyOn(performance, 'now').mockReturnValue(0);
        fake.currentTime = 0;
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();
        epoch.arm();

        // Act
        fake.state = 'suspended';
        fake.dispatchStatechange();
        fake.state = 'closed';
        fake.dispatchStatechange();

        // Assert (the unconditional first-running rule never engages
        // because we never reach 'running'; rebaseCount stays 0)
        expect(onRebase).not.toHaveBeenCalled();
        expect(epoch.rebaseCount).toBe(0);
    });

    it('stop() removes the listener so subsequent statechange dispatches are inert', () => {
        // Arrange
        const {fake, asContext} = createFake();
        vi.spyOn(performance, 'now').mockReturnValue(0);
        fake.currentTime = 0;
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();
        epoch.arm();
        expect(fake.listenerCount).toBe(1);

        // Act
        epoch.stop();
        fake.state = 'running';
        fake.dispatchStatechange();

        // Assert
        expect(fake.listenerCount).toBe(0);
        expect(onRebase).not.toHaveBeenCalled();
    });

    it('stop() is idempotent', () => {
        // Arrange
        const {fake, asContext} = createFake();
        const onRebase = vi.fn<(offset: number) => void>();
        const epoch = new AudioContextEpoch({audioContext: asContext, onRebase});
        epoch.captureInitialOffset();
        epoch.arm();

        // Act / Assert (a second stop must not double-remove or throw)
        epoch.stop();
        epoch.stop();
        expect(fake.listenerCount).toBe(0);
    });
});
