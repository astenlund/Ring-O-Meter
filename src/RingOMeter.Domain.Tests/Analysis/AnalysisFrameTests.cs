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
        var a = new AnalysisFrame("ch1", 1000, 440.0f, 0.95f, -12.0f);
        var b = new AnalysisFrame("ch1", 1000, 440.0f, 0.95f, -12.0f);

        // Act / Assert
        a.Should().Be(b);
    }

    [Fact]
    public void Round_trips_through_messagepack()
    {
        // Arrange
        var original = new AnalysisFrame("ch2", 12345, 220.5f, 0.8f, -18.0f);

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
        var frame = new AnalysisFrame("ch1", 0, 0f, 0f, -60f);

        // Act / Assert
        frame.FundamentalHz.Should().Be(0);
    }
}
