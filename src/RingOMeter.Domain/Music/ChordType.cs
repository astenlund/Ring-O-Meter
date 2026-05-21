namespace RingOMeter.Domain.Music;

/// <summary>
/// Chord types the MVP classifier considers. Declaration order is part of
/// the wire-contract tie-break rule: when two hypotheses produce identical
/// fit sums, the lower index wins. Per CLAUDE.md, do not rename or reorder
/// existing members.
/// </summary>
public enum ChordType
{
    Major = 0,
    DominantSeventh = 1,
    Minor = 2,
    Diminished = 3,
    MinorSeventh = 4,
}
