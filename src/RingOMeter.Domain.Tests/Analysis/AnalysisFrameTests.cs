using FluentAssertions;
using MessagePack;
using RingOMeter.Domain.Analysis;

namespace RingOMeter.Domain.Tests.Analysis;

public class AnalysisFrameTests
{
    [Fact]
    public void Records_with_same_values_are_equal()
    {
        // Arrange
        var a = TestData.Frame(clientTsMs: 1000, fundamentalHz: 440f, confidence: 0.95f, rmsDb: -12f);
        var b = TestData.Frame(clientTsMs: 1000, fundamentalHz: 440f, confidence: 0.95f, rmsDb: -12f);

        // Act / Assert
        a.Should().Be(b);
    }

    [Fact]
    public void Round_trips_through_messagepack()
    {
        // Arrange (raw differs from canonical to prove the new key survives)
        var original = TestData.Frame(
            channelId: "ch2",
            clientTsMs: 12345,
            fundamentalHz: 220.5f,
            confidence: 0.8f,
            rmsDb: -18f,
            fundamentalHzRaw: 441f);

        // Act
        var bytes = MessagePackSerializer.Serialize(original);
        var restored = MessagePackSerializer.Deserialize<AnalysisFrame>(bytes);

        // Assert
        restored.Should().Be(original);
    }

    [Fact]
    public void Unvoiced_frame_has_zero_fundamental()
    {
        // Arrange
        var frame = TestData.Frame(fundamentalHz: 0f, confidence: 0f, rmsDb: -60f);

        // Act / Assert
        frame.FundamentalHz.Should().Be(0);
        frame.FundamentalHzRaw.Should().Be(0);
    }
}
