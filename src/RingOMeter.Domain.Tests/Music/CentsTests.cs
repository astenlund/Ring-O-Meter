using FluentAssertions;
using RingOMeter.Domain.Music;

namespace RingOMeter.Domain.Tests.Music;

public class CentsTests
{
    [Fact]
    public void Zero_is_default()
    {
        // Arrange / Act
        var c = default(Cents);

        // Assert
        c.Value.Should().Be(0);
    }

    [Fact]
    public void Addition_works()
    {
        // Arrange
        var a = new Cents(12.5);
        var b = new Cents(-7.25);

        // Act
        var sum = a + b;

        // Assert
        sum.Value.Should().BeApproximately(5.25, 1e-9);
    }

    [Fact]
    public void Subtraction_works()
    {
        // Arrange
        var a = new Cents(50);
        var b = new Cents(20);

        // Act
        var diff = a - b;

        // Assert
        diff.Value.Should().Be(30);
    }

    [Theory]
    [InlineData(0, "0c")]
    [InlineData(12, "+12c")]
    [InlineData(-7, "-7c")]
    [InlineData(12.5, "+13c")]
    public void ToString_formats_with_sign(double value, string expected)
    {
        // Arrange
        var c = new Cents(value);

        // Act
        var result = c.ToString();

        // Assert
        result.Should().Be(expected);
    }

    [Fact]
    public void Comparison_uses_value()
    {
        // Arrange
        var a = new Cents(5);
        var b = new Cents(10);

        // Act / Assert
        (a < b).Should().BeTrue();
        (b > a).Should().BeTrue();
        a.CompareTo(b).Should().BeNegative();
    }
}
