using System.Diagnostics;

namespace Survact.Sim;

/// <summary>Accumulates wall time per system. Attach to Simulation.Profiler for the HUD or perf tests.</summary>
public sealed class SystemProfiler
{
    public static readonly string[] Names = ["Climate", "Heater", "Needs", "Think", "Movement", "Work", "Construction", "Death"];

    private readonly long[] _ticks = new long[Names.Length];
    public long Steps { get; private set; }

    internal void Run(int slot, Simulation sim, Action<Simulation> system)
    {
        long start = Stopwatch.GetTimestamp();
        system(sim);
        _ticks[slot] += Stopwatch.GetTimestamp() - start;
        if (slot == Names.Length - 1) Steps++;
    }

    /// <summary>Average milliseconds per step for each system since the last reset.</summary>
    public double AverageMs(int slot) => Steps == 0 ? 0 : _ticks[slot] * 1000.0 / Stopwatch.Frequency / Steps;

    public void Reset()
    {
        Array.Clear(_ticks);
        Steps = 0;
    }

    public override string ToString() =>
        string.Join("  ", Names.Select((n, i) => $"{n} {AverageMs(i):F2}"));
}
