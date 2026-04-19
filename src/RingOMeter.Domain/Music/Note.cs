using System.Globalization;
using System.Text.RegularExpressions;

namespace RingOMeter.Domain.Music;

public readonly record struct Note(string Name, int Octave, int MidiNumber)
{
    private static readonly string[] SharpNames =
        ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    private static readonly Dictionary<string, int> NameToOffset = new(StringComparer.OrdinalIgnoreCase)
    {
        ["C"] = 0,
        ["C#"] = 1,
        ["Db"] = 1,
        ["D"] = 2,
        ["D#"] = 3,
        ["Eb"] = 3,
        ["E"] = 4,
        ["F"] = 5,
        ["F#"] = 6,
        ["Gb"] = 6,
        ["G"] = 7,
        ["G#"] = 8,
        ["Ab"] = 8,
        ["A"] = 9,
        ["A#"] = 10,
        ["Bb"] = 10,
        ["B"] = 11,
    };

    private static readonly Regex Pattern = new(@"^([A-G])([#b]?)(-?\d+)$", RegexOptions.Compiled);

    public static Note FromMidi(int midi)
    {
        if (midi < 0 || midi > 127)
        {
            throw new ArgumentOutOfRangeException(nameof(midi), midi, "MIDI note must be in 0..127");
        }

        var name = SharpNames[midi % 12];
        var octave = (midi / 12) - 1;

        return new Note(name, octave, midi);
    }

    public static Note Parse(string input)
    {
        var match = Pattern.Match(input);
        if (!match.Success)
        {
            throw new FormatException($"'{input}' is not a valid note name (expected e.g. C4, F#3, Bb5)");
        }

        var letter = match.Groups[1].Value;
        var accidental = match.Groups[2].Value;
        var octave = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
        var key = letter + accidental;

        if (!NameToOffset.TryGetValue(key, out var offset))
        {
            throw new FormatException($"'{input}' has an unknown accidental");
        }

        var midi = ((octave + 1) * 12) + offset;
        if (midi < 0 || midi > 127)
        {
            throw new FormatException($"'{input}' is outside MIDI 0..127");
        }

        return FromMidi(midi);
    }
}
