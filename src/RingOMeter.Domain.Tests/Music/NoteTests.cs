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

    [Fact]
    public void FromMidi_and_Parse_round_trip_for_every_valid_midi()
    {
        // Arrange / Act / Assert: the SharpNames array and NameToOffset
        // dictionary are two encodings of the same pitch-class mapping.
        // If someone edits one but forgets the other, this round-trip
        // loop catches it: FromMidi uses SharpNames to produce a string,
        // Parse uses NameToOffset to resolve it back to a midi number.
        for (var midi = 0; midi <= 127; midi++)
        {
            var note = Note.FromMidi(midi);
            var roundTripped = Note.Parse(note.Name + note.Octave);
            roundTripped.MidiNumber.Should().Be(midi);
        }
    }
}
