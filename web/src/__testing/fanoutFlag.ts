// Test-only: URL query-string feature flag for the ?fanout=N rendering
// load test. Parsed once at App mount; returns null in production.
//
// Separated from fanoutVoiceChannel.ts so the parser (a pure utility
// with no browser-API or worklet imports) can be tested or read
// without pulling in fanoutWorklet.ts?worker&url.
//
// Cleanup: rm this file along with fanoutWorklet.ts, fanoutVoiceChannel.ts,
// and fanoutConstants.ts when the fanout test mode is retired.

export interface FanoutFlag {
    count: number;
    offsetsCents: number[];
}

const MAX_FANOUT_COUNT = 16;
const DEFAULT_OFFSET_STEP_CENTS = 8;

/**
 * Parse `?fanout=N` (and optional `?offsets=a,b,c,...`) from a URL
 * search string. Returns a normalised {count, offsetsCents} (with
 * `offsetsCents.length === count` always) for valid input, or null for
 * the production path.
 *
 * Validation guarantees the worklet's pitchMultipliers[i] lookup never
 * yields undefined or NaN, which would otherwise propagate NaN through
 * FrameRingWriter.publish into the SAB ring (the writer does not
 * validate input columns; readers and the canvas would render garbage).
 *
 * Examples:
 *   ?fanout=4                       -> {count:4, offsetsCents:[0,8,16,24]}
 *   ?fanout=4&offsets=0,15,30,45    -> {count:4, offsetsCents:[0,15,30,45]}
 *   ?fanout=4&offsets=0,5           -> {count:4, offsetsCents:[0,5,16,24]} (pad)
 *   ?fanout=4&offsets=0,5,10,15,20  -> {count:4, offsetsCents:[0,5,10,15]} (truncate)
 *   ?fanout=0|-1|4.5|garbage|>16    -> null + console.warn
 *   ?offsets=0,abc,30,45            -> null + console.warn
 *   no fanout param                 -> null (production path)
 */
export function parseFanoutFlag(search: string): FanoutFlag | null {
    const params = new URLSearchParams(search);
    const fanoutParam = params.get('fanout');
    if (fanoutParam === null) {
        return null;
    }
    // Number() rejects fractional strings ("4.5" -> 4.5, not an integer)
    // while parseInt("4.5") would silently truncate to 4.
    const count = Number(fanoutParam);
    if (!Number.isInteger(count) || count < 1) {
        console.warn(`[fanout] invalid count ${fanoutParam}; using production path`);

        return null;
    }
    if (count > MAX_FANOUT_COUNT) {
        console.warn(
            `[fanout] count ${count} exceeds cap ${MAX_FANOUT_COUNT}; using production path`,
        );

        return null;
    }

    const offsetsParam = params.get('offsets');
    if (offsetsParam === null) {
        return {
            count,
            offsetsCents: Array.from({length: count}, (_, i) => i * DEFAULT_OFFSET_STEP_CENTS),
        };
    }
    const supplied = offsetsParam.split(',').map((s) => Number.parseFloat(s));
    if (supplied.some((n) => !Number.isFinite(n))) {
        console.warn(
            `[fanout] non-numeric entry in offsets=${offsetsParam}; using production path`,
        );

        return null;
    }
    // supplied is a dense array; supplied[i] is undefined for i >= supplied.length.
    const offsetsCents = Array.from({length: count}, (_, i) =>
        supplied[i] !== undefined ? supplied[i] : i * DEFAULT_OFFSET_STEP_CENTS,
    );

    return {count, offsetsCents};
}
