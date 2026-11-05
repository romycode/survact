using System.Diagnostics;
using Survact.Sim;
using Survact.Sim.Persistence;

// Usage: dotnet run -c Release --project tests/Survact.Sim.Tests [-- filter]
var filter = args.Length > 0 ? args[0] : null;
var tests = new (string Name, Action Body)[]
{
    ("determinism: same seed, same world", Determinism),
    ("save/load: roundtrip continues identically", SaveLoadRoundtrip),
    ("invariants: 10 game days, no NaN, no leaks", LongRunInvariants),
    ("perf: 2000 colonists on 512x512 stays under budget", PerfBudget),
};

int failed = 0;
foreach (var (name, body) in tests)
{
    if (filter is not null && !name.Contains(filter, StringComparison.OrdinalIgnoreCase)) continue;
    var sw = Stopwatch.StartNew();
    try
    {
        body();
        Console.WriteLine($"PASS  {name}  ({sw.ElapsedMilliseconds} ms)");
    }
    catch (Exception e)
    {
        failed++;
        Console.WriteLine($"FAIL  {name}\n      {e.Message}");
    }
}
return failed == 0 ? 0 : 1;

static void Determinism()
{
    var settings = new SimSettings(Seed: 42, InitialColonists: 80);
    var a = Simulation.Create(settings);
    var b = Simulation.Create(settings);
    for (int t = 0; t < 3000; t++)
    {
        a.Step();
        b.Step();
        if (t % 500 == 0) Assert(a.StateHash() == b.StateHash(), $"diverged at tick {t}");
    }
    Assert(a.StateHash() == b.StateHash(), "diverged at end");

    var other = Simulation.Create(settings with { Seed = 43 });
    other.Step(3000);
    Assert(other.StateHash() != a.StateHash(), "different seeds produced identical worlds");
}

static void SaveLoadRoundtrip()
{
    var sim = Simulation.Create(new SimSettings(Seed: 7, InitialColonists: 60));
    sim.Step(1500);

    using var ms = new MemoryStream();
    SaveGame.Save(sim, ms);
    ms.Position = 0;
    var loaded = SaveGame.Load(ms);

    Assert(loaded.StateHash() == sim.StateHash(), "hash differs right after load");
    sim.Step(1500);
    loaded.Step(1500);
    Assert(loaded.StateHash() == sim.StateHash(), "loaded world diverged after 1500 more ticks");
}

static void LongRunInvariants()
{
    var sim = Simulation.Create(new SimSettings(Seed: 1234, InitialColonists: 200));
    int days = 10;
    for (int d = 0; d < days; d++)
    {
        sim.Step(Simulation.TicksPerDay);
        var c = sim.Colonists;
        for (int i = 0; i < c.Count; i++)
        {
            Assert(float.IsFinite(c.X[i]) && float.IsFinite(c.Y[i]), $"non-finite position, colonist {i}");
            Assert(c.Hunger[i] is >= 0 and <= 1 && c.Warmth[i] is >= 0 and <= 1, $"need out of range, colonist {i}");
            Assert(sim.Map.InBounds((int)c.X[i], (int)c.Y[i]), $"colonist {i} out of map");
        }
        Assert(sim.Colony.Wood >= 0 && sim.Colony.Food >= 0, "negative stock");

        // Every reserved tile must be targeted by exactly one living colonist (no leaked reservations).
        int reserved = 0;
        for (int t = 0; t < sim.Map.Count; t++) if (sim.Map.IsReserved(t)) reserved++;
        int targeting = 0;
        for (int i = 0; i < c.Count; i++) if (c.Target[i] >= 0) targeting++;
        Assert(reserved == targeting, $"day {d}: {reserved} reserved tiles vs {targeting} targets");

        Console.WriteLine($"      day {sim.Day,2}  temp {sim.Temperature,6:F1}°C  alive {c.Count,4}  dead {sim.Colony.Deaths,4}  wood {sim.Colony.Wood,5}  food {sim.Colony.Food,5}");
    }
}

static void PerfBudget()
{
    const int colonists = 2000;
    const int ticks = 3000;
    const double p99BudgetMs = 8.0; // a 30 Hz tick has 33 ms; leave most of it to rendering and x10 speed

    var sim = Simulation.Create(new SimSettings(Seed: 99, Width: 512, Height: 512, InitialColonists: colonists));
    sim.Step(300); // warm up JIT / tiered compilation
    var profiler = new SystemProfiler();
    sim.Profiler = profiler;

    var samples = new double[ticks];
    long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
    var sw = new Stopwatch();
    for (int t = 0; t < ticks; t++)
    {
        sw.Restart();
        sim.Step();
        samples[t] = sw.Elapsed.TotalMilliseconds;
    }
    long allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;

    Array.Sort(samples);
    double avg = samples.Average();
    double p99 = samples[(int)(ticks * 0.99)];
    double max = samples[^1];
    Console.WriteLine($"      avg {avg:F3} ms  p99 {p99:F3} ms  max {max:F3} ms  alloc {allocated / 1024.0:F0} KB over {ticks} ticks  paths {sim.PathQueries} failed {sim.PathFailures} nodes/query {sim.PathNodesExpanded / Math.Max(1, sim.PathQueries)} fieldRebuilds {sim.FieldRebuilds}");
    Console.WriteLine($"      per system (ms): {profiler}");

    Assert(p99 < p99BudgetMs, $"p99 {p99:F2} ms exceeds {p99BudgetMs} ms budget");
    Assert(allocated < 1024 * 1024, $"steady-state allocation too high: {allocated / 1024} KB");
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}
