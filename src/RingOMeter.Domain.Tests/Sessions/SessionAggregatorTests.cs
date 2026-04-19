using FluentAssertions;
using RingOMeter.Domain.Analysis;
using RingOMeter.Domain.Sessions;

namespace RingOMeter.Domain.Tests.Sessions;

public class SessionAggregatorTests
{
    [Fact]
    public void First_frame_appears_in_snapshot()
    {
        // Arrange
        var agg = new SessionAggregator("dev", () => 1000);
        var frame = new AnalysisFrame("ch1", 500, 440f, 0.9f, -10f);

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
        var older = new AnalysisFrame("ch1", 500, 220f, 0.7f, -15f);
        var newer = new AnalysisFrame("ch1", 600, 440f, 0.9f, -10f);

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
        var newer = new AnalysisFrame("ch1", 600, 440f, 0.9f, -10f);
        var older = new AnalysisFrame("ch1", 500, 220f, 0.7f, -15f);

        // Act
        agg.Apply(newer);
        agg.Apply(older);

        // Assert
        agg.Snapshot().LatestPerChannel["ch1"].Should().Be(newer);
    }

    [Fact]
    public void Multiple_channels_coexist()
    {
        // Arrange
        var agg = new SessionAggregator("dev", () => 1000);
        var f1 = new AnalysisFrame("ch1", 100, 220f, 0.9f, -10f);
        var f2 = new AnalysisFrame("ch2", 110, 330f, 0.85f, -11f);

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
        agg.Apply(new AnalysisFrame("ch1", 100, 220f, 0.9f, -10f));
        var s1 = agg.Snapshot();
        agg.Apply(new AnalysisFrame("ch1", 200, 230f, 0.9f, -10f));
        var s2 = agg.Snapshot();

        // Assert
        s2.SeqNo.Should().BeGreaterThan(s1.SeqNo);
    }

    [Fact]
    public void ChannelRemoved_drops_the_channel_from_snapshot()
    {
        // Arrange
        var agg = new SessionAggregator("dev", () => 1000);
        agg.Apply(new AnalysisFrame("ch1", 100, 220f, 0.9f, -10f));
        agg.Apply(new AnalysisFrame("ch2", 100, 330f, 0.9f, -10f));

        // Act
        agg.RemoveChannel("ch1");

        // Assert
        agg.Snapshot().LatestPerChannel.Should().ContainKey("ch2").And.NotContainKey("ch1");
    }
}
