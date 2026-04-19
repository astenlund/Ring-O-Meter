using MessagePack;

namespace RingOMeter.Domain.Analysis;

[MessagePackObject]
public sealed record AnalysisFrame(
    [property: Key(0)] string ChannelId,
    [property: Key(1)] long ClientTsMs,
    [property: Key(2)] float FundamentalHz,
    [property: Key(3)] float Confidence,
    [property: Key(4)] float RmsDb);
