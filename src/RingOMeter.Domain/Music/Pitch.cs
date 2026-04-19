namespace RingOMeter.Domain.Music;

// Mirror: web/src/music/pitch.ts nearestNote(). Both implement the same
// A4=440 / MIDI 69 Hz-to-note math and share two invariants (locked by
// tests on both sides): throw on non-positive hz, and throw when the
// rounded MIDI falls outside [0, 127]. Keep semantics aligned when
// either side changes.
public readonly record struct Pitch(double Hz)
{
    private const double A4Hz = 440.0;
    private const int A4Midi = 69;

    public (Note Note, Cents Cents) NearestNote()
    {
        // `Hz <= 0` alone would let NaN through (all NaN comparisons return
        // false in C#), and PositiveInfinity would slip into Math.Log2 to
        // produce an infinite midiExact. Mirror the TS side's
        // `!(hz > 0) || !Number.isFinite(hz)` exactly.
        if (!(Hz > 0) || !double.IsFinite(Hz))
        {
            throw new InvalidOperationException("Pitch.Hz must be positive and finite to map to a note");
        }

        var midiExact = A4Midi + (12.0 * Math.Log2(Hz / A4Hz));
        var midi = (int)Math.Round(midiExact, MidpointRounding.AwayFromZero);
        if (midi is < 0 or > 127)
        {
            // Clamping would silently produce cents far outside [-50, +50]
            // (e.g. Hz = 30_000 reports "G9 +2300c"), so refuse instead.
            throw new InvalidOperationException("Pitch.Hz maps outside the MIDI range [0, 127]");
        }

        var cents = new Cents((midiExact - midi) * 100.0);
        var note = Note.FromMidi(midi);

        return (note, cents);
    }
}
