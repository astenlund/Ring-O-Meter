/**
 * Async init-guard with deferred-replay queue. Callers invoke `defer(msg)`
 * while `state === 'pending'`, then `markReady(replay)` drains the queue.
 * `markFailed()` is terminal and drops the queue -- consumers that rely on
 * a successful init handshake should not retry, which matches the original
 * module-scope `initFailed` flag behavior in `plotWorkerWebgpu.ts`.
 *
 * In `plotWorkerWebgpu.ts`, `traceGate` calls both `markReady` and
 * `markFailed` (the trace init has a hard-fail path). `vowelGate` only ever
 * calls `markReady` -- vowel init failure posts `vowelInitError` to main but
 * leaves the gate in `'pending'` (matching the old `vowelInitialised = false`
 * behavior). A future retry path would call `markFailed()` here before
 * attempting a new init.
 */
export class ReadyGate<T> {
    private state: 'pending' | 'ready' | 'failed' = 'pending';
    private readonly pending: T[] = [];

    isReady(): boolean { return this.state === 'ready'; }
    isFailed(): boolean { return this.state === 'failed'; }

    defer(msg: T): void {
        if (this.state === 'pending') {
            this.pending.push(msg);
        }
    }

    markReady(replay: (msg: T) => void): void {
        this.state = 'ready';
        for (const queued of this.pending) {
            replay(queued);
        }
        this.pending.length = 0;
    }

    markFailed(): void {
        this.state = 'failed';
        this.pending.length = 0;
    }
}
