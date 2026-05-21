using FluentAssertions;
using RingOMeter.Domain.Music;
using Xunit;

namespace RingOMeter.Domain.Tests.Music;

public class ChordTypeTests
{
    [Theory]
    [InlineData(ChordType.Major, 0)]
    [InlineData(ChordType.DominantSeventh, 1)]
    [InlineData(ChordType.Minor, 2)]
    [InlineData(ChordType.Diminished, 3)]
    [InlineData(ChordType.MinorSeventh, 4)]
    public void ChordType_int_value_matches_TS_mirror(ChordType type, int expected)
    {
        // Arrange + Act + Assert: the TS mirror at web/src/wire/chord.ts pins
        // these numeric values for the future MessagePack wire contract.
        // Renaming or reordering a member here silently breaks deserialization
        // on the other language side.
        ((int)type).Should().Be(expected);
    }

    [Fact]
    public void ChordType_member_count_locked()
    {
        // Arrange + Act
        var count = Enum.GetValues<ChordType>().Length;

        // Assert: adding a new member requires bumping this count AND adding
        // a matching entry in web/src/wire/chord.ts. The lock keeps additions
        // explicit so the two sides cannot drift silently.
        count.Should().Be(5);
    }
}
