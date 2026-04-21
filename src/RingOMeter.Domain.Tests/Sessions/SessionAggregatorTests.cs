using FluentAssertions;
using RingOMeter.Domain.Sessions;

namespace RingOMeter.Domain.Tests.Sessions;

public class SessionAggregatorTests
{
    [Fact]
    public void First_frame_appears_in_snapshot()
    {
        // Arrange
        var agg = new SessionAggregator("dev", () => 1000);
        var frame = TestData.Frame(clientTsMs: 500, fundamentalHz: 440f);

        // Act
        agg.Apply(frame);
        var update = agg.Snapshot();

        // Assert
        update.SessionId.Should().Be("dev");
        update.LatestPerChannel.Should().ContainKey("ch1").WhoseValue.Should().Be(frame);
        update.SeqNo.Should().Be(1);
        update.ServerTsMs.Should().Be(1000);
    }

    [Fact]
    public void Newer_frame_replaces_older_for_same_channel()
    {
        // Arrange
        var agg = new SessionAggregator("dev", () => 1000);
        var older = TestData.Frame(clientTsMs: 500, fundamentalHz: 220f, confidence: 0.7f, rmsDb: -15f);
        var newer = TestData.Frame(clientTsMs: 600, fundamentalHz: 440f);

        // Act
        agg.Apply(older);
        agg.Apply(newer);

        // Assert
        agg.Snapshot().LatestPerChannel["ch1"].Should().Be(newer);
    }

    [Fact]
    public void Stale_frame_is_dropped()
    {
        // Arrange
        var agg = new SessionAggregator("dev", () => 1000);
        var newer = TestData.Frame(clientTsMs: 600, fundamentalHz: 440f);
        var older = TestData.Frame(clientTsMs: 500, fundamentalHz: 220f, confidence: 0.7f, rmsDb: -15f);

        // Act
        agg.Apply(newer);
        agg.Apply(older);

        // Assert
        agg.Snapshot().LatestPerChannel["ch1"].Should().Be(newer);
    }

    [Fact]
    public void Equal_timestamp_frame_replaces_existing()
    {
        // Arrange: tie-break semantics of Apply use `>=`, so a frame arriving
        // with the same ClientTsMs as the existing one wins. Locks the
        // behaviour against accidental change to `>`.
        var agg = new SessionAggregator("dev", () => 1000);
        var first = TestData.Frame(clientTsMs: 500, fundamentalHz: 220f, confidence: 0.7f, rmsDb: -15f);
        var tied = TestData.Frame(clientTsMs: 500, fundamentalHz: 440f);

        // Act
        agg.Apply(first);
        agg.Apply(tied);

        // Assert
        agg.Snapshot().LatestPerChannel["ch1"].Should().Be(tied);
    }

    [Fact]
    public void Multiple_channels_coexist()
    {
        // Arrange
        var agg = new SessionAggregator("dev", () => 1000);
        var f1 = TestData.Frame(clientTsMs: 100, fundamentalHz: 220f);
        var f2 = TestData.Frame(channelId: "ch2", clientTsMs: 110, fundamentalHz: 330f, confidence: 0.85f, rmsDb: -11f);

        // Act
        agg.Apply(f1);
        agg.Apply(f2);

        // Assert
        agg.Snapshot().LatestPerChannel.Should().HaveCount(2);
    }

    [Fact]
    public void Snapshot_increments_sequence()
    {
        // Arrange
        var agg = new SessionAggregator("dev", () => 1000);

        // Act
        agg.Apply(TestData.Frame(clientTsMs: 100, fundamentalHz: 220f));
        var s1 = agg.Snapshot();
        agg.Apply(TestData.Frame(clientTsMs: 200, fundamentalHz: 230f));
        var s2 = agg.Snapshot();

        // Assert
        s2.SeqNo.Should().BeGreaterThan(s1.SeqNo);
    }

    [Fact]
    public void ChannelRemoved_drops_the_channel_from_snapshot()
    {
        // Arrange
        var agg = new SessionAggregator("dev", () => 1000);
        agg.Apply(TestData.Frame(clientTsMs: 100, fundamentalHz: 220f));
        agg.Apply(TestData.Frame(channelId: "ch2", clientTsMs: 100, fundamentalHz: 330f));

        // Act
        agg.RemoveChannel("ch1");

        // Assert
        agg.Snapshot().LatestPerChannel.Should().ContainKey("ch2").And.NotContainKey("ch1");
    }
}
