// Ring-indicator color thresholds. Shared by App.tsx (per-voice ring
// classification) and the chord-bars renderers (target-zone +
// background-band visualization). Consumers must move together if
// retuned; the heuristic-introspection panel will eventually surface
// these for live retuning.

// heuristic: ring-indicator-green-cents - per-voice residual at or
// below this magnitude classifies as in-tune; the chord-bars green
// target zone has this half-width.
export const GREEN_THRESHOLD_CENTS = 5;

// heuristic: ring-indicator-yellow-outer-cents - any voice with
// |residual| above this magnitude pushes the ring indicator to red;
// voices in (GREEN_THRESHOLD_CENTS, YELLOW_BAND_OUTER_CENTS] count
// as yellow, and 2+ yellow voices also resolve to red.
export const YELLOW_BAND_OUTER_CENTS = 15;
