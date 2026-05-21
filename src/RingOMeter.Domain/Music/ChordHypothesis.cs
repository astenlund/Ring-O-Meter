namespace RingOMeter.Domain.Music;

/// <summary>
/// Per-chord-type JI ratio table, translated to cents at construction.
/// TargetCents[0] is always 0 (root). MinArity = TargetCents.Count.
/// </summary>
public readonly record struct ChordHypothesis(ChordType Type, IReadOnlyList<double> TargetCents)
{
    // Static field declared before methods to satisfy StyleCop SA1202
    // (element ordering by access).
    public static readonly IReadOnlyList<ChordType> AllTypes =
        [ChordType.Major, ChordType.DominantSeventh, ChordType.Minor,
         ChordType.Diminished, ChordType.MinorSeventh];

    public int MinArity => TargetCents.Count;

    public static ChordHypothesis For(ChordType type) => type switch
    {
        ChordType.Major => new(
            type,
            [0.0, RatioCents(5, 4), RatioCents(3, 2)]),
        ChordType.DominantSeventh => new(
            type,
            [0.0, RatioCents(5, 4), RatioCents(3, 2), RatioCents(7, 4)]),
        ChordType.Minor => new(
            type,
            [0.0, RatioCents(6, 5), RatioCents(3, 2)]),
        ChordType.Diminished => new(
            type,
            [0.0, RatioCents(6, 5), RatioCents(7, 5)]),
        ChordType.MinorSeventh => new(
            type,
            [0.0, RatioCents(6, 5), RatioCents(3, 2), RatioCents(9, 5)]),
        _ => throw new ArgumentOutOfRangeException(nameof(type), type, "Unknown chord type"),
    };

    private static double RatioCents(int num, int denom) =>
        1200.0 * Math.Log2((double)num / denom);
}
