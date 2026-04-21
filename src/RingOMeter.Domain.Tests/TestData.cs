using RingOMeter.Domain.Analysis;

namespace RingOMeter.Domain.Tests;

// Centralized AnalysisFrame construction for tests. Appending a [Key(N)] to
// AnalysisFrame only requires updating Frame()'s signature here; individual
// test sites stay untouched unless they care about the new field. Raw
// defaults to canonical because most tests are indifferent to the
// correction distinction.
internal static class TestData
{
    public static AnalysisFrame Frame(
        string channelId = "ch1",
        long clientTsMs = 0,
        float fundamentalHz = 440f,
        float confidence = 0.9f,
        float rmsDb = -10f,
        float? fundamentalHzRaw = null)
    {
        return new AnalysisFrame(
            channelId,
            clientTsMs,
            fundamentalHz,
            confidence,
            rmsDb,
            fundamentalHzRaw ?? fundamentalHz);
    }
}
