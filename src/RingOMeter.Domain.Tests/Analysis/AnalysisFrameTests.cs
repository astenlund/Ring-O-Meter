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

    [Fact]
    public void Round_trips_formants_through_messagepack()
    {
        // Arrange
        var original = TestData.Frame(
            channelId: "ch3",
            clientTsMs: 22222,
            fundamentalHz: 220f,
            confidence: 0.9f,
            rmsDb: -15f,
            fundamentalHzRaw: 220f,
            f1Hz: 500f,
            f2Hz: 1500f,
            f3Hz: 2500f,
            f4Hz: 3500f);

        // Act
        var bytes = MessagePackSerializer.Serialize(original);
        var restored = MessagePackSerializer.Deserialize<AnalysisFrame>(bytes);

        // Assert
        restored.Should().Be(original);
        restored.F1Hz.Should().Be(500f);
        restored.F2Hz.Should().Be(1500f);
        restored.F3Hz.Should().Be(2500f);
        restored.F4Hz.Should().Be(3500f);
    }
}
