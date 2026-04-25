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

    /// <summary>
    /// Applies a new frame. Every call increments <c>SeqNo</c>, including
    /// calls where the tie-break drops the frame as stale: a stale Apply
    /// is still an observable mutation attempt that clients may want to
    /// reason about. Use the frame payload, not <c>SeqNo</c>, to tell
    /// whether state actually changed. Asymmetric with
    /// <see cref="RemoveChannel"/>, which is silent on no-op: a stale
    /// Apply is still a real network event worth surfacing, whereas
    /// removing an absent channel is unambiguously a no-op.
    /// </summary>
    public void Apply(AnalysisFrame frame)
    {
        _latest.AddOrUpdate(
            frame.ChannelId,
            frame,
            (_, existing) => frame.ClientTsMs >= existing.ClientTsMs ? frame : existing);
        Interlocked.Increment(ref _seqNo);
    }

    /// <summary>
    /// Removes a channel. Increments <c>SeqNo</c> only when a channel
    /// was actually present, so a no-op remove is invisible to clients.
    /// </summary>
    public void RemoveChannel(string channelId)
    {
        if (_latest.TryRemove(channelId, out _))
        {
            Interlocked.Increment(ref _seqNo);
        }
    }

    /// <summary>
    /// Returns a point-in-time snapshot. <c>SeqNo</c> counts mutation
    /// operations (Apply and successful RemoveChannel), not Snapshot
    /// calls, so consecutive Snapshot callers with no intervening
    /// mutation see the same SeqNo. Under concurrent writers the
    /// (state, SeqNo) pair is best-effort: the writer's two atomic
    /// operations (dictionary mutation and SeqNo increment) are not
    /// atomic as a pair, so a Snapshot interleaving between them can
    /// observe the new state with the pre-bump SeqNo (or the pre-
    /// mutation state with the post-bump SeqNo, depending on order).
    /// The chosen reader order (dict copy first, SeqNo read second)
    /// minimises the more confusing direction (fresh-seq-stale-state)
    /// and bounds the worst case to a one-poll delay before the client
    /// re-observes the now-bumped SeqNo over the same state — a
    /// mutation is never lost, only re-acknowledged. Strict pairing
    /// would require a shared lock on Apply's mutate+increment and
    /// Snapshot's copy+read; this design accepts the looser contract
    /// for lock-free Apply throughput.
    /// Interlocked.Read is required for atomic 64-bit load on 32-bit
    /// platforms.
    /// </summary>
    public SessionUpdate Snapshot()
    {
        // ConcurrentDictionary's copy constructor uses its snapshot enumerator
        // under the hood, so one copy instead of the two that ToArray +
        // ToDictionary produces.
        var snapshot = new Dictionary<string, AnalysisFrame>(_latest);
        var seq = Interlocked.Read(ref _seqNo);

        return new SessionUpdate(SessionId, seq, _nowMs(), snapshot);
    }
}
