using FluentAssertions;
using RingOMeter.Domain.Music;

namespace RingOMeter.Domain.Tests.Music;

public class PitchTests
{
    [Fact]
    public void A4_is_440_hz_at_zero_cents()
    {
        // Arrange
        var pitch = new Pitch(440.0);

        // Act
        var (note, cents) = pitch.NearestNote();

        // Assert
        note.Should().Be(Note.Parse("A4"));
        cents.Value.Should().BeApproximately(0, 1e-6);
    }

    [Theory]
    [InlineData(261.6256, "C4")]
    [InlineData(523.2511, "C5")]
    [InlineData(110.0, "A2")]
    public void Common_pitches_map_to_expected_note_within_one_cent(double hz, string expectedName)
    {
        // Arrange
        var pitch = new Pitch(hz);

        // Act
        var (note, cents) = pitch.NearestNote();

        // Assert
        note.Should().Be(Note.Parse(expectedName));
        Math.Abs(cents.Value).Should().BeLessThan(1.0);
    }

    [Fact]
    public void Twelve_cents_sharp_reports_positive_offset()
    {
        // Arrange
        // 440 * 2^(12/1200) ~= 443.06
        var pitch = new Pitch(440.0 * Math.Pow(2, 12.0 / 1200.0));

        // Act
        var (note, cents) = pitch.NearestNote();

        // Assert
        note.Should().Be(Note.Parse("A4"));
        cents.Value.Should().BeApproximately(12, 0.01);
    }

    [Fact]
    public void Zero_or_negative_hz_throws()
    {
        // Arrange / Act
        Action act = () => new Pitch(0).NearestNote();

        // Assert
        act.Should().Throw<InvalidOperationException>();
    }
}
