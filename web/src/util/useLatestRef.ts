import {useRef, type RefObject} from 'react';

// Mirrors a value into a ref on every render, so effects whose dep
// arrays must stay stable can still read the latest committed value
// at event time. Idempotent render-time mutation: assigning the same
// value to the same ref slot has no observable effect, but lets a
// subsequent event-handler closure read through .current and see
// whatever the most recent commit produced.
//
// Use when an effect needs to react to events using the latest value
// of X without re-subscribing on every change to X (typical when the
// re-subscription would race against events fired during the same
// commit, dropping callbacks for entities X newly references).
export function useLatestRef<T>(value: T): RefObject<T> {
    const ref = useRef(value);
    ref.current = value;

    return ref;
}
