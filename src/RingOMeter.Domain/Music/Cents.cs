using System.Globalization;

namespace RingOMeter.Domain.Music;

public readonly record struct Cents(double Value) : IComparable<Cents>
{
    public static Cents operator +(Cents a, Cents b)
    {
        return new Cents(a.Value + b.Value);
    }

    public static Cents operator -(Cents a, Cents b)
    {
        return new Cents(a.Value - b.Value);
    }

    public static bool operator <(Cents a, Cents b)
    {
        return a.Value < b.Value;
    }

    public static bool operator >(Cents a, Cents b)
    {
        return a.Value > b.Value;
    }

    public static bool operator <=(Cents a, Cents b)
    {
        return a.Value <= b.Value;
    }

    public static bool operator >=(Cents a, Cents b)
    {
        return a.Value >= b.Value;
    }

    public int CompareTo(Cents other)
    {
        return Value.CompareTo(other.Value);
    }

    public override string ToString()
    {
        var rounded = (int)Math.Round(Value, MidpointRounding.AwayFromZero);
        if (rounded == 0)
        {
            return "0c";
        }

        var sign = rounded > 0 ? "+" : string.Empty;

        return string.Create(CultureInfo.InvariantCulture, $"{sign}{rounded}c");
    }
}
