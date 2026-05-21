using FluentAssertions;
using RingOMeter.Domain.Music;
using Xunit;

namespace RingOMeter.Domain.Tests.Music;

public class ChordHypothesisTests
{
    [Fact]
    public void Major_has_three_chord_tones_at_expected_JI_cents()
    {
        // Arrange
        var hyp = ChordHypothesis.For(ChordType.Major);

        // Act
        var cents = hyp.TargetCents;

        // Assert
        cents.Should().HaveCount(3);
        cents[0].Should().Be(0);
        cents[1].Should().BeApproximately(386.31, 0.01); // 5:4
        cents[2].Should().BeApproximately(701.96, 0.01); // 3:2
    }

    [Fact]
    public void DominantSeventh_has_four_chord_tones_including_low_seventh()
    {
        // Arrange
        var hyp = ChordHypothesis.For(ChordType.DominantSeventh);

        // Act + Assert
        hyp.TargetCents.Should().HaveCount(4);
        hyp.TargetCents[3].Should().BeApproximately(968.83, 0.01); // 7:4
    }

    [Fact]
    public void MinorSeventh_uses_9_5_for_seventh_not_7_4()
    {
        // Arrange
        var hyp = ChordHypothesis.For(ChordType.MinorSeventh);

        // Act + Assert
        hyp.TargetCents[3].Should().BeApproximately(1017.60, 0.01); // 9:5
    }

    [Fact]
    public void MinArity_matches_chord_tone_count()
    {
        // Arrange + Act + Assert
        ChordHypothesis.For(ChordType.Major).MinArity.Should().Be(3);
        ChordHypothesis.For(ChordType.DominantSeventh).MinArity.Should().Be(4);
    }
}
