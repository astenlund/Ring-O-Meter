using MessagePack;

namespace RingOMeter.Domain.Analysis;

[MessagePackObject]
public sealed record PeerInfo(
    [property: Key(0)] string ClientId,
    [property: Key(1)] ClientRole Role,
    [property: Key(2)] string? DisplayName);
