// Owns the rebase-gating policy that translates AudioContext
// statechange events into perfNow->contextTimeZero offset rebases
// for downstream readers. Extracted from VoiceChannel so the policy
// is unit-testable without standing up a mic + worklet pipeline.
//
// Policy:
//   - The first 'running' transition ALWAYS fires onRebase. The
//     pre-running offset captured at start() is a placeholder
//     (currentTime = 0 while suspended) that needs to be corrected
//     once the context actually anchors.
//   - Subsequent 'running' transitions fire onRebase only when the
//     observed offset has drifted by more than REBASE_THRESHOLD_MS
//     from the last propagated value. This filters sub-millisecond
//     steady-state jitter while still catching real suspend/resume
//     reanchors (which typically shift by tens to hundreds of ms).
//   - 'suspended' and 'closed' transitions are no-ops.

// Subset of AudioContext that this module consumes. Real
// AudioContext satisfies it structurally; tests pass a hand-rolled
// stub.
export type RebaseAudioContext = Pick<
    AudioContext,
    'currentTime' | 'state' | 'addEventListener' | 'removeEventListener'
>;

// heuristic: rebase-drift-threshold-ms - sub-ms drift between polls
// is treated as steady-state noise and not propagated; larger
// shifts indicate a real reanchor (suspend/resume) and trigger a
// downstream rebase.
export const REBASE_THRESHOLD_MS = 1;

export interface AudioContextEpochOptions {
    audioContext: RebaseAudioContext;
    onRebase: (offsetMs: number) => void;
}

export class AudioContextEpoch {
    private readonly audioContext: RebaseAudioContext;
    private readonly onRebase: (offsetMs: number) => void;
    private hasFiredRunningRebase = false;
    private lastPropagatedOffset = 0;
    private stateChangeHandler: (() => void) | null = null;
    private _rebaseCount = 0;

    public constructor(opts: AudioContextEpochOptions) {
        this.audioContext = opts.audioContext;
        this.onRebase = opts.onRebase;
    }

    public get rebaseCount(): number {
        return this._rebaseCount;
    }

    // Captures the placeholder offset for the caller to seed downstream
    // readers with. While the AudioContext is suspended (pre-user-
    // gesture), currentTime = 0 and the offset = performance.now() at
    // this call; the first entry to 'running' triggers a rebase that
    // corrects this placeholder. Pure read; safe to call before arm().
    public captureInitialOffset(): number {
        const initialOffset = this.computeOffset();
        this.lastPropagatedOffset = initialOffset;

        return initialOffset;
    }

    // Subscribes to future statechange events. Separate from
    // captureInitialOffset so the caller (today: VoiceChannel.start)
    // can interleave reader/worklet wiring between the two calls and
    // attach the listener at the original moment in the lifecycle.
    // Throws on double-arm to surface a misuse that would silently
    // leak a listener and double-count rebases.
    public arm(): void {
        if (this.stateChangeHandler !== null) {
            throw new Error('AudioContextEpoch.arm() called twice');
        }
        this.stateChangeHandler = (): void => this.handleStateChange();
        this.audioContext.addEventListener('statechange', this.stateChangeHandler);
    }

    public stop(): void {
        if (this.stateChangeHandler !== null) {
            this.audioContext.removeEventListener('statechange', this.stateChangeHandler);
            this.stateChangeHandler = null;
        }
    }

    private computeOffset(): number {
        return performance.now() - this.audioContext.currentTime * 1000;
    }

    private handleStateChange(): void {
        if (this.audioContext.state !== 'running') {
            return;
        }
        const offset = this.computeOffset();
        const shouldFire = !this.hasFiredRunningRebase
            || Math.abs(offset - this.lastPropagatedOffset) > REBASE_THRESHOLD_MS;
        if (!shouldFire) {
            return;
        }
        this.hasFiredRunningRebase = true;
        this.lastPropagatedOffset = offset;
        this._rebaseCount += 1;
        this.onRebase(offset);
    }
}
