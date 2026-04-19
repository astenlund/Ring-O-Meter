using MessagePack;

namespace RingOMeter.Domain.Analysis;

// slice 1: TS mirror will be added to web/src/wire/frames.ts when the hub
// starts broadcasting peer rosters. Keep [Key] order stable until then.
[MessagePackObject]
public sealed record PeerInfo(
    [property: Key(0)] string ClientId,
    [property: Key(1)] ClientRole Role,
    [property: Key(2)] string? DisplayName);
