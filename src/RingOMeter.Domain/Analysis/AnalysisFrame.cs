using MessagePack;

namespace RingOMeter.Domain.Analysis;

// Mirror: web/src/wire/frames.ts AnalysisFrame. Keep [Key] order in sync;
// appending fields is safe, renaming or reordering existing keys is a
// wire-breaking change.
[MessagePackObject]
public sealed record AnalysisFrame(
    [property: Key(0)] string ChannelId,
    [property: Key(1)] long ClientTsMs,
    [property: Key(2)] float FundamentalHz,
    [property: Key(3)] float Confidence,
    [property: Key(4)] float RmsDb);
