using MessagePack;

namespace RingOMeter.Domain.Analysis;

// Mirror: web/src/wire/frames.ts FormantTuple. Keep [Key] order in sync;
// appending fields is safe, renaming or reordering existing keys is a
// wire-breaking change.
//
// F1Hz..F4Hz: 0 is the FORMANT_ABSENT_SENTINEL meaning "no formant detected
// in this slot" (mirror of FORMANT_ABSENT_SENTINEL in
// web/src/audio/frameRing.ts). Detector NaN is mapped to 0 before SAB
// transit; consumers gate on `f*Hz > 0`. 0 is physically nonsensical as a
// real formant frequency and aligns with AnalysisFrame.FundamentalHz's
// "0 means no pitch" convention.
[MessagePackObject]
public readonly record struct FormantTuple(
    [property: Key(0)] float F1Hz,
    [property: Key(1)] float F2Hz,
    [property: Key(2)] float F3Hz,
    [property: Key(3)] float F4Hz);
