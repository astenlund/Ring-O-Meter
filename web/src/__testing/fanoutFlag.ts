// Permanent dev-mode infrastructure; gated by devModesEnabled in /config.json.

let _warnedAboutIgnoredFanout = false;

export interface FanoutFlag {
    count: number;
    offsetsCents: number[];
}

const MAX_FANOUT_COUNT = 16;
// JI dom7 chord (root / maj-3 / P5 / harmonic-7) computed from the
// exact ratios so the chord-aware-display sees zero per-voice residual
// under fanout. The classifier targets ratio-precise cents
// (1200 * log2(ratio)); integer-rounded approximations like
// [0, 386, 702, 969] leave residuals of -0.31¢ / +0.04¢ / +0.17¢
// because 386 != 386.31..., 702 != 701.96..., 969 != 968.83.... Default
// when ?fanout is bare or count === 4 and no explicit offsets given.
const DEFAULT_DOM7_OFFSETS_CENTS = [
    0,
    1200 * Math.log2(5 / 4),   // ≈ 386.31
    1200 * Math.log2(3 / 2),   // ≈ 701.96
    1200 * Math.log2(7 / 4),   // ≈ 968.83
] as const;
// Step pattern used as the default for non-dom7 counts (count !== 4).
// 8 cents is barely audible, intentional for renderer-stress scenarios
// where stacked-near-unison traces test occlusion / anti-aliasing
// behavior. Also used to pad partially-supplied offsets up to count.
const DEFAULT_OFFSET_STEP_CENTS = 8;
// `?fanout` with no value (or `?fanout=`) defaults to a dom7 quartet,
// matching the e2e + CLAUDE.md convention so a developer typing the
// flag from memory gets the chord they expect.
const DEFAULT_COUNT_FOR_BARE_FLAG = 4;

function defaultOffsetsFor(count: number): number[] {
    if (count === 4) {
        return [...DEFAULT_DOM7_OFFSETS_CENTS];
    }

    return Array.from({length: count}, (_, i) => i * DEFAULT_OFFSET_STEP_CENTS);
}

/**
 * Parse `?fanout` / `?fanout=N` (and optional `?offsets=a,b,c,...`) from
 * a URL search string. Returns a normalised {count, offsetsCents} (with
 * `offsetsCents.length === count` always) for valid input, or null for
 * the production path.
 *
 * Validation guarantees the worklet's pitchMultipliers[i] lookup never
 * yields undefined or NaN, which would otherwise propagate NaN through
 * FrameRingWriter.publish into the SAB ring (the writer does not
 * validate input columns; readers and the canvas would render garbage).
 *
 * Examples:
 *   ?fanout                         -> {count:4, offsetsCents:JI-dom7 ratios}  (bare flag)
 *   ?fanout=4                       -> {count:4, offsetsCents:JI-dom7 ratios}  (dom7)
 *   ?fanout=4&offsets=0,15,30,45    -> {count:4, offsetsCents:[0,15,30,45]}
 *   ?fanout=4&offsets=0,5           -> {count:4, offsetsCents:[0,5,16,24]} (pad)
 *   ?fanout=4&offsets=0,5,10,15,20  -> {count:4, offsetsCents:[0,5,10,15]} (truncate)
 *   ?fanout=2                       -> {count:2, offsetsCents:[0,8]} (step)
 *   ?fanout=0|-1|4.5|garbage|>16    -> null + console.warn
 *   ?offsets=0,abc,30,45            -> null + console.warn
 *   no fanout param                 -> null (production path)
 */
export function parseFanoutFlag(search: string, devModesEnabled = false): FanoutFlag | null {
    const params = new URLSearchParams(search);
    const fanoutParam = params.get('fanout');
    if (fanoutParam === null) {
        return null;
    }
    if (!devModesEnabled) {
        if (!_warnedAboutIgnoredFanout) {
            console.warn('[ring-o-meter] ?fanout flag ignored in this environment (devModesEnabled: false)');
            _warnedAboutIgnoredFanout = true;
        }

        return null;
    }
    // URLSearchParams returns '' for `?fanout` (no value) and `?fanout=`
    // (explicit empty value). Both shapes mean "give me the canonical
    // test pattern" rather than "invalid count".
    const count = fanoutParam === '' ? DEFAULT_COUNT_FOR_BARE_FLAG : Number(fanoutParam);
    // Number() rejects fractional strings ("4.5" -> 4.5, not an integer)
    // while parseInt("4.5") would silently truncate to 4.
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
        return {count, offsetsCents: defaultOffsetsFor(count)};
    }
    const supplied = offsetsParam.split(',').map((s) => Number.parseFloat(s));
    if (supplied.some((n) => !Number.isFinite(n))) {
        console.warn(
            `[fanout] non-numeric entry in offsets=${offsetsParam}; using production path`,
        );

        return null;
    }
    // supplied is a dense array; supplied[i] is undefined for i >= supplied.length.
    // Pads short input with the step pattern (not dom7): the user supplied
    // SOME explicit values, signalling they want a custom shape, so the
    // pad fills the tail with a benign linear progression rather than
    // fabricating a chord they didn't ask for.
    const offsetsCents = Array.from({length: count}, (_, i) =>
        supplied[i] !== undefined ? supplied[i] : i * DEFAULT_OFFSET_STEP_CENTS,
    );

    return {count, offsetsCents};
}
