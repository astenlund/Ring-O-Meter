using FluentAssertions;
using MessagePack;
using RingOMeter.Domain.Analysis;

namespace RingOMeter.Domain.Tests.Analysis;

public class SessionUpdateTests
{
    [Fact]
    public void Round_trips_through_messagepack_with_two_voices()
    {
        // Arrange
        var frame1 = TestData.Frame(clientTsMs: 100, fundamentalHz: 220f);
        var frame2 = TestData.Frame(channelId: "ch2", clientTsMs: 100, fundamentalHz: 330f, confidence: 0.85f, rmsDb: -12f);
        var update = new SessionUpdate(
            "dev",
            42,
            200,
            new Dictionary<string, AnalysisFrame> { ["ch1"] = frame1, ["ch2"] = frame2 });

        // Act
        var bytes = MessagePackSerializer.Serialize(update);
        var restored = MessagePackSerializer.Deserialize<SessionUpdate>(bytes);

        // Assert
        restored.SessionId.Should().Be("dev");
        restored.SeqNo.Should().Be(42);
        restored.ServerTsMs.Should().Be(200);
        restored.LatestPerChannel.Should().HaveCount(2);
        restored.LatestPerChannel["ch1"].Should().Be(frame1);
        restored.LatestPerChannel["ch2"].Should().Be(frame2);
    }
}
