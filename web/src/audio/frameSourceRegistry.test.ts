import {describe, expect, it, vi} from 'vitest';
import {FrameSourceRegistry, type FrameSourceSubscriber} from './frameSourceRegistry';
import type {FrameRingReader, FrameSource} from './frameRing';

function makeSubscriber() {
    return {
        onReady: vi.fn<FrameSourceSubscriber['onReady']>(),
        onRebased: vi.fn<FrameSourceSubscriber['onRebased']>(),
        onGone: vi.fn<FrameSourceSubscriber['onGone']>(),
    };
}

// The registry never reads source/reader fields; tests pass typed sentinels
// rather than constructing real SABs and FrameRingReaders.
const fakeSource = {} as FrameSource;
const fakeReader = {} as FrameRingReader;

describe('FrameSourceRegistry', () => {
    it('fans every lifecycle event out to a single subscriber', () => {
        // Arrange
        const registry = new FrameSourceRegistry();
        const sub = makeSubscriber();
        registry.subscribe(sub);

        // Act
        registry.onFrameSourceReady('ch-1', fakeSource, fakeReader);
        registry.onFrameSourceRebased('ch-1', 12.5);
        registry.onFrameSourceGone('ch-1');

        // Assert
        expect(sub.onReady).toHaveBeenCalledExactlyOnceWith('ch-1', fakeSource, fakeReader);
        expect(sub.onRebased).toHaveBeenCalledExactlyOnceWith('ch-1', 12.5);
        expect(sub.onGone).toHaveBeenCalledExactlyOnceWith('ch-1');
    });

    it('fans an event to multiple subscribers in registration order', () => {
        // Arrange
        const registry = new FrameSourceRegistry();
        const order: string[] = [];
        const subA: FrameSourceSubscriber = {
            onReady: () => order.push('A'),
            onRebased: () => undefined,
            onGone: () => undefined,
        };
        const subB: FrameSourceSubscriber = {
            onReady: () => order.push('B'),
            onRebased: () => undefined,
            onGone: () => undefined,
        };
        registry.subscribe(subA);
        registry.subscribe(subB);

        // Act
        registry.onFrameSourceReady('ch-1', fakeSource, fakeReader);

        // Assert
        expect(order).toEqual(['A', 'B']);
    });

    it('stops delivering events after unsubscribe, leaving siblings intact', () => {
        // Arrange
        const registry = new FrameSourceRegistry();
        const subA = makeSubscriber();
        const subB = makeSubscriber();
        const unsubA = registry.subscribe(subA);
        registry.subscribe(subB);

        // Act
        unsubA();
        registry.onFrameSourceReady('ch-1', fakeSource, fakeReader);
        registry.onFrameSourceGone('ch-1');

        // Assert
        expect(subA.onReady).not.toHaveBeenCalled();
        expect(subA.onGone).not.toHaveBeenCalled();
        expect(subB.onReady).toHaveBeenCalledOnce();
        expect(subB.onGone).toHaveBeenCalledOnce();
    });

    it('treats a double-unsubscribe as a no-op', () => {
        // Arrange
        const registry = new FrameSourceRegistry();
        const sub = makeSubscriber();
        const unsub = registry.subscribe(sub);

        // Act
        unsub();
        unsub();
        registry.onFrameSourceReady('ch-1', fakeSource, fakeReader);

        // Assert
        expect(sub.onReady).not.toHaveBeenCalled();
    });

    it('resumes delivery when the same subscriber re-subscribes', () => {
        // Arrange
        const registry = new FrameSourceRegistry();
        const sub = makeSubscriber();
        const unsub = registry.subscribe(sub);
        unsub();

        // Act
        registry.subscribe(sub);
        registry.onFrameSourceReady('ch-1', fakeSource, fakeReader);

        // Assert
        expect(sub.onReady).toHaveBeenCalledOnce();
    });

    it('delivers each event N times when the same subscriber subscribes N times', () => {
        // Arrange: subscribe is push-based (no identity dedupe). Two subscribe
        // calls with the same instance net two deliveries per event. Locked so a
        // future identity-dedupe change is a deliberate decision, not silent.
        const registry = new FrameSourceRegistry();
        const sub = makeSubscriber();
        registry.subscribe(sub);
        registry.subscribe(sub);

        // Act
        registry.onFrameSourceReady('ch-1', fakeSource, fakeReader);

        // Assert
        expect(sub.onReady).toHaveBeenCalledTimes(2);
    });

    it('lets siblings receive an event when one subscriber unsubscribes mid-fanout', () => {
        // Arrange: pins the snapshot-on-iterate invariant. Without it, a
        // self-unsubscribe (or sibling unsubscribe) inside a callback would
        // splice the live array and the for-of loop would skip the next entry.
        const registry = new FrameSourceRegistry();
        const subB = makeSubscriber();
        const subC = makeSubscriber();
        let unsubB: (() => void) | null = null;
        const subAReady = vi.fn<FrameSourceSubscriber['onReady']>(() => unsubB?.());
        const subA: FrameSourceSubscriber = {
            onReady: subAReady,
            onRebased: () => undefined,
            onGone: () => undefined,
        };
        registry.subscribe(subA);
        unsubB = registry.subscribe(subB);
        registry.subscribe(subC);

        // Act
        registry.onFrameSourceReady('ch-1', fakeSource, fakeReader);

        // Assert: subA fires (the trigger), then subB still fires from the
        // snapshot even though it was just removed from the live array, then
        // subC fires. The subA assertion guards against a future bug where
        // snapshot mechanics disrupt the currently-iterating subscriber.
        expect(subAReady).toHaveBeenCalledOnce();
        expect(subB.onReady).toHaveBeenCalledOnce();
        expect(subC.onReady).toHaveBeenCalledOnce();
    });
});
