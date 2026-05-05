// Mirror: src/RingOMeter.Domain/Analysis/AnalysisFrame.cs. Keep [Key] order
// identical to the C# [MessagePackObject] declarations. Adding fields means
// appending the next free index on both sides simultaneously; renaming or
// reordering existing keys is a wire-breaking change.
//
// fundamentalHz is the canonical (capture-side octave-stabilized) value;
// fundamentalHzRaw is the verbatim YIN output. They are equal when no
// correction fired. Consumers default to fundamentalHz; the raw value is
// preserved so logging / re-analysis / heuristic-introspection tooling can
// audit the correction after the fact.
//
// f1Hz..f4Hz carry the FORMANT_ABSENT_SENTINEL = 0 contract from
// audio/frameRing.ts: 0 means "no formant detected in this slot"
// (detector NaN mapped before SAB transit). Consumers gate on `f*Hz > 0`.

export interface AnalysisFrame {
    channelId: string;        // [Key(0)]
    clientTsMs: number;       // [Key(1)]
    fundamentalHz: number;    // [Key(2)]
    confidence: number;       // [Key(3)]
    rmsDb: number;            // [Key(4)]
    fundamentalHzRaw: number; // [Key(5)]
    f1Hz: number;             // [Key(6)]
    f2Hz: number;             // [Key(7)]
    f3Hz: number;             // [Key(8)]
    f4Hz: number;             // [Key(9)]
}
