using MessagePack;

namespace RingOMeter.Domain.Analysis;

// Mirror: web/src/wire/frames.ts AnalysisFrame. Keep [Key] order in sync;
// appending fields is safe, renaming or reordering existing keys is a
// wire-breaking change.
//
// FundamentalHz is the canonical (capture-side octave-stabilized) value;
// FundamentalHzRaw is the verbatim YIN output. They are equal when no
// correction fired. Consumers default to FundamentalHz; the raw value stays
// on the wire so logging, re-analysis, and heuristic-introspection tooling
// can audit the correction after the fact.
//
// F1Hz..F4Hz: 0 is the FORMANT_ABSENT_SENTINEL meaning "no formant detected
// in this slot" (mirror of FORMANT_ABSENT_SENTINEL in
// web/src/audio/frameRing.ts). Detector NaN is mapped to 0 before SAB
// transit; consumers gate on `f*Hz > 0`. 0 is physically nonsensical as a
// real formant frequency and aligns with FundamentalHz's "0 means no
// pitch" convention.
[MessagePackObject]
public sealed record AnalysisFrame(
    [property: Key(0)] string ChannelId,
    [property: Key(1)] long ClientTsMs,
    [property: Key(2)] float FundamentalHz,
    [property: Key(3)] float Confidence,
    [property: Key(4)] float RmsDb,
    [property: Key(5)] float FundamentalHzRaw,
    [property: Key(6)] float F1Hz,
    [property: Key(7)] float F2Hz,
    [property: Key(8)] float F3Hz,
    [property: Key(9)] float F4Hz);
