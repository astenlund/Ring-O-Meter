using System.Collections.Concurrent;
using RingOMeter.Domain.Analysis;

namespace RingOMeter.Domain.Sessions;

public sealed class SessionAggregator
{
    private readonly ConcurrentDictionary<string, AnalysisFrame> _latest = new();
    private readonly Func<long> _nowMs;
    private long _seqNo;

    public SessionAggregator(string sessionId, Func<long> nowMs)
    {
        SessionId = sessionId ?? throw new ArgumentNullException(nameof(sessionId));
        _nowMs = nowMs ?? throw new ArgumentNullException(nameof(nowMs));
    }

    public string SessionId { get; }

    public void Apply(AnalysisFrame frame)
    {
        _latest.AddOrUpdate(
            frame.ChannelId,
            frame,
            (_, existing) => frame.ClientTsMs >= existing.ClientTsMs ? frame : existing);
    }

    public void RemoveChannel(string channelId)
    {
        _latest.TryRemove(channelId, out _);
    }

    public SessionUpdate Snapshot()
    {
        var seq = Interlocked.Increment(ref _seqNo);
        var snapshot = _latest.ToArray()
            .ToDictionary(kvp => kvp.Key, kvp => kvp.Value);

        return new SessionUpdate(SessionId, seq, _nowMs(), snapshot);
    }
}
