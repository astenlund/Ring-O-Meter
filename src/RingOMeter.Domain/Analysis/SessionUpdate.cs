using MessagePack;

namespace RingOMeter.Domain.Analysis;

// slice 1: TS mirror will be added to web/src/wire/frames.ts when the hub
// starts broadcasting these updates. Keep [Key] order stable until then.
[MessagePackObject]
public sealed record SessionUpdate(
    [property: Key(0)] string SessionId,
    [property: Key(1)] long SeqNo,
    [property: Key(2)] long ServerTsMs,
    [property: Key(3)] IReadOnlyDictionary<string, AnalysisFrame> LatestPerChannel);
