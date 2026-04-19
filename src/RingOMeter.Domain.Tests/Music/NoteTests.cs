using FluentAssertions;
using RingOMeter.Domain.Music;

namespace RingOMeter.Domain.Tests.Music;

public class NoteTests
{
    [Theory]
    [InlineData(60, "C", 4)]
    [InlineData(69, "A", 4)]
    [InlineData(0, "C", -1)]
    [InlineData(127, "G", 9)]
    [InlineData(61, "C#", 4)]
    public void FromMidi_returns_expected_name_and_octave(int midi, string expectedName, int expectedOctave)
    {
        // Arrange / Act
        var note = Note.FromMidi(midi);

        // Assert
        note.Name.Should().Be(expectedName);
        note.Octave.Should().Be(expectedOctave);
        note.MidiNumber.Should().Be(midi);
    }

    [Theory]
    [InlineData("C4", 60)]
    [InlineData("A4", 69)]
    [InlineData("C#4", 61)]
    [InlineData("Bb3", 58)]
    [InlineData("G9", 127)]
    public void Parse_round_trips_via_midi(string input, int expectedMidi)
    {
        // Arrange / Act
        var note = Note.Parse(input);

        // Assert
        note.MidiNumber.Should().Be(expectedMidi);
    }

    [Theory]
    [InlineData("H4")]
    [InlineData("")]
    [InlineData("C")]
    [InlineData("C##4")]
    public void Parse_rejects_invalid_input(string input)
    {
        // Arrange / Act
        Action act = () => Note.Parse(input);

        // Assert
        act.Should().Throw<FormatException>();
    }

    [Fact]
    public void FromMidi_rejects_out_of_range()
    {
        // Arrange / Act
        Action act = () => Note.FromMidi(128);

        // Assert
        act.Should().Throw<ArgumentOutOfRangeException>();
    }
}
