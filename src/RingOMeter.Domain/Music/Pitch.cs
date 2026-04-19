namespace RingOMeter.Domain.Music;

public readonly record struct Pitch(double Hz)
{
    private const double A4Hz = 440.0;
    private const int A4Midi = 69;

    public (Note Note, Cents Cents) NearestNote()
    {
        if (Hz <= 0)
        {
            throw new InvalidOperationException("Pitch.Hz must be positive to map to a note");
        }

        var midiExact = A4Midi + (12.0 * Math.Log2(Hz / A4Hz));
        var midi = (int)Math.Round(midiExact, MidpointRounding.AwayFromZero);
        midi = Math.Clamp(midi, 0, 127);
        var cents = new Cents((midiExact - midi) * 100.0);
        var note = Note.FromMidi(midi);

        return (note, cents);
    }
}
