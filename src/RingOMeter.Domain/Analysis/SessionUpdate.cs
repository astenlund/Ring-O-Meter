using MessagePack;

namespace RingOMeter.Domain.Analysis;

// Mirror: web/src/wire/frames.ts SessionUpdate. Keep [Key] order in sync.
[MessagePackObject]
public sealed record SessionUpdate(
    [property: Key(0)] string SessionId,
    [property: Key(1)] long SeqNo,
    [property: Key(2)] long ServerTsMs,
    [property: Key(3)] IReadOnlyDictionary<string, AnalysisFrame> LatestPerChannel);
