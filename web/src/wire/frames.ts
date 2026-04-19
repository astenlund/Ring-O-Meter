// Hand-mirrored from RingOMeter.Domain.Analysis. Keep [Key] order identical
// to the C# [MessagePackObject] declarations. Adding fields means appending
// the next free index on both sides simultaneously.

export interface AnalysisFrame {
    channelId: string;        // [Key(0)]
    clientTsMs: number;       // [Key(1)]
    fundamentalHz: number;    // [Key(2)]
    confidence: number;       // [Key(3)]
    rmsDb: number;            // [Key(4)]
}
