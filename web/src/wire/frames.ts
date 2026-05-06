// Mirror: src/RingOMeter.Domain/Analysis/AnalysisFrame.cs and FormantTuple.cs.
// Keep [Key] order identical to the C# [MessagePackObject] declarations.
// Adding fields means appending the next free index on both sides
// simultaneously; renaming or reordering existing keys is a wire-breaking
// change.
//
// fundamentalHz is the canonical (capture-side octave-stabilized) value;
// fundamentalHzRaw is the verbatim YIN output. They are equal when no
// correction fired. Consumers default to fundamentalHz; the raw value is
// preserved so logging / re-analysis / heuristic-introspection tooling can
// audit the correction after the fact.
//
// formants nests four formant slots under a single Key(6) on AnalysisFrame.
// Each slot carries the FORMANT_ABSENT_SENTINEL = 0 contract from
// audio/frameRing.ts: 0 means "no formant detected in this slot"
// (detector NaN mapped before SAB transit). Consumers gate on `f*Hz > 0`.

// No direct named import yet: today FormantTuple is consumed only
// via AnalysisFrame.formants below. The SignalR DisplayClient (when
// the hub feature lands) will import this type by name to construct
// hub-fed AnalysisFrame instances; until then the export keeps the
// wire surface symmetric with the C# FormantTuple record struct.
export interface FormantTuple {
    f1Hz: number;             // [Key(0)]
    f2Hz: number;             // [Key(1)]
    f3Hz: number;             // [Key(2)]
    f4Hz: number;             // [Key(3)]
}

export interface AnalysisFrame {
    channelId: string;        // [Key(0)]
    clientTsMs: number;       // [Key(1)]
    fundamentalHz: number;    // [Key(2)]
    confidence: number;       // [Key(3)]
    rmsDb: number;            // [Key(4)]
    fundamentalHzRaw: number; // [Key(5)]
    formants: FormantTuple;   // [Key(6)]
}
