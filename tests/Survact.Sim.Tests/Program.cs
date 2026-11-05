using System.Diagnostics;
using Survact.Sim;
using Survact.Sim.Commands;
using Survact.Sim.Data;
using Survact.Sim.Persistence;

// Usage: dotnet run -c Release --project tests/Survact.Sim.Tests [-- filter]
// Tests run against the real game data (game/data/balance.json), the same file the game ships.
var filter = args.Length > 0 ? args[0] : null;
var tests = new (string Name, Action Body)[]
{
    ("data: shipped balance.json loads", DataLoads),
    ("data: typos and bad values are rejected", DataRejectsBadInput),
    ("terrain: mountains and cliffs exist, nobody walks through a cliff", TerrainCliffs),
    ("determinism: same seed, same world", Determinism),
    ("commands: replay of seed + log reproduces the session", ReplayReproducesSession),
    ("commands: invalid commands are rejected, not applied", InvalidCommandsRejected),
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

static void DataLoads()
{
    var b = TestData.Game.Balance;
    Assert(b.TicksPerDay == 240 * Simulation.TicksPerSecond, $"ticks per day {b.TicksPerDay}");
    Assert(b.GatherTicks == 90, $"gather ticks {b.GatherTicks}");
    Assert(TestData.Game.Tiles.MoveCost(Survact.Sim.World.Tile.Water) == 0, "water must be impassable");
}

static void DataRejectsBadInput()
{
    string json = TestData.Json;
    ExpectReject(json.Replace("\"eat_below\"", "\"eat_bellow\""), "unknown field");
    ExpectReject(json.Replace("\"carry_capacity\": 5,", ""), "missing required field");
    ExpectReject(json.Replace("\"carry_capacity\": 5", "\"carry_capacity\": 0"), "carry_capacity");
    ExpectReject(json.Replace("\"snow\":  { \"move_cost\": 14 }", "\"slush\": { \"move_cost\": 14 }"), "unknown tile");

    static void ExpectReject(string json, string what)
    {
        try
        {
            GameData.FromJson(json);
        }
        catch (GameDataException)
        {
            return;
        }
        throw new Exception($"data with {what} was accepted");
    }
}

static void TerrainCliffs()
{
    var sim = Simulation.Create(new SimSettings(Seed: 1337, InitialColonists: 120), TestData.Game);
    var map = sim.Map;

    int maxLevel = 0, cliffEdges = 0;
    for (int i = 0; i < map.Count; i++)
    {
        maxLevel = Math.Max(maxLevel, map.LevelAt(i));
        int x = map.X(i);
        if (x + 1 < map.Width && map.Rules.Walkable(map.Get(i)) && map.Rules.Walkable(map.Get(i + 1))
            && Math.Abs(map.LevelAt(i) - map.LevelAt(i + 1)) >= 2) cliffEdges++;
    }
    Assert(maxLevel >= 8, $"no real mountains (max level {maxLevel})");
    Assert(cliffEdges >= 100, $"too few cliffs ({cliffEdges} horizontal cliff edges)");

    // Every step of every live path, and every flow-field step home, must be a legal step.
    for (int t = 0; t < 30; t++)
    {
        sim.Step(100);
        var c = sim.Colonists;
        for (int i = 0; i < c.Count; i++)
        {
            if (c.Nav[i] != Survact.Sim.Entities.Nav.Path) continue;
            int prev = map.Index((int)c.X[i], (int)c.Y[i]);
            var path = c.PathSlice(i);
            for (int k = c.PathPos[i]; k < c.PathLength[i]; k++)
            {
                // The colonist may be between its tile and the next node: only check node-to-node.
                if (k > c.PathPos[i]) Assert(map.CanStep(prev, path[k]), $"path crosses a cliff or wall at node {path[k]}");
                prev = path[k];
            }
        }
    }

    var field = sim.StockpileField;
    for (int i = 0; i < map.Count; i += 7)
    {
        if (field.DistanceAt(i) is 0 or Survact.Sim.Pathfinding.FlowField.Unreachable) continue;
        int next = field.Next(i);
        Assert(next >= 0, $"reachable tile {i} has no downhill step");
        Assert(map.CanStep(i, next), $"flow field steps across a cliff from {i} to {next}");
    }
}

static void ReplayReproducesSession()
{
    var settings = new SimSettings(Seed: 2024, InitialColonists: 40);
    var live = Simulation.Create(settings, TestData.Game);
    var c = live.Colony;
    for (int t = 0; t < 2400; t++)
    {
        if (t == 100) live.Enqueue(Command.SpawnColonists(c.StockX, c.StockY, 25));
        if (t == 700) live.Enqueue(Command.AddStock(wood: -30, food: 200));
        if (t == 1200) live.Enqueue(Command.SetClimateOffset(-15f));
        live.Step();
    }
    Assert(live.CommandLog.Count == 3, $"expected 3 logged commands, got {live.CommandLog.Count}");

    var replayed = Simulation.Create(settings, TestData.Game);
    Replay.Run(replayed, live.CommandLog, live.Tick);
    Assert(replayed.StateHash() == live.StateHash(), "replay diverged from the live session");

    var noCommands = Simulation.Create(settings, TestData.Game);
    noCommands.Step(2400);
    Assert(noCommands.StateHash() != live.StateHash(), "commands had no effect on state");
}

static void InvalidCommandsRejected()
{
    var sim = Simulation.Create(new SimSettings(Seed: 5, InitialColonists: 10), TestData.Game);
    var rejected = new List<string>();
    sim.CommandRejected += (_, reason) => rejected.Add(reason);

    int before = sim.Colonists.Count;
    sim.Enqueue(Command.SpawnColonists(-5, 3, 10));                                   // out of bounds
    sim.Enqueue(Command.SpawnColonists(sim.Colony.StockX, sim.Colony.StockY, 0));    // bad count
    sim.Enqueue(Command.SetClimateOffset(500f));                                      // out of range
    sim.Step();

    Assert(rejected.Count == 3, $"expected 3 rejections, got {rejected.Count}: {string.Join("; ", rejected)}");
    Assert(sim.Colonists.Count == before, "rejected spawn still spawned colonists");
    Assert(sim.CommandLog.Count == 0, "rejected commands must not enter the replay log");
}

static void Determinism()
{
    var settings = new SimSettings(Seed: 42, InitialColonists: 80);
    var a = Simulation.Create(settings, TestData.Game);
    var b = Simulation.Create(settings, TestData.Game);
    for (int t = 0; t < 3000; t++)
    {
        a.Step();
        b.Step();
        if (t % 500 == 0) Assert(a.StateHash() == b.StateHash(), $"diverged at tick {t}");
    }
    Assert(a.StateHash() == b.StateHash(), "diverged at end");

    var other = Simulation.Create(settings with { Seed = 43 }, TestData.Game);
    other.Step(3000);
    Assert(other.StateHash() != a.StateHash(), "different seeds produced identical worlds");
}

static void SaveLoadRoundtrip()
{
    var sim = Simulation.Create(new SimSettings(Seed: 7, InitialColonists: 60), TestData.Game);
    sim.Step(1500);
    sim.Enqueue(Command.AddStock(10, 10)); // pending at save time: must survive the roundtrip

    using var ms = new MemoryStream();
    SaveGame.Save(sim, ms);
    ms.Position = 0;
    var loaded = SaveGame.Load(ms, TestData.Game);

    Assert(loaded.StateHash() == sim.StateHash(), "hash differs right after load");
    sim.Step(1500);
    loaded.Step(1500);
    Assert(loaded.StateHash() == sim.StateHash(), "loaded world diverged after 1500 more ticks");
}

static void LongRunInvariants()
{
    var sim = Simulation.Create(new SimSettings(Seed: 1234, InitialColonists: 200), TestData.Game);
    int days = 10;
    for (int d = 0; d < days; d++)
    {
        sim.Step(sim.Balance.TicksPerDay);
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

    var sim = Simulation.Create(new SimSettings(Seed: 99, Width: 512, Height: 512, InitialColonists: colonists), TestData.Game);
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

static class TestData
{
    private static readonly Lazy<string> JsonText = new(() => File.ReadAllText(FindDataFile("balance.json")));
    private static readonly Lazy<GameData> Data = new(() => GameData.FromJson(JsonText.Value));

    public static string Json => JsonText.Value;
    public static GameData Game => Data.Value;

    /// <summary>Walks up from the test binary to the repo root, then into game/data.</summary>
    private static string FindDataFile(string name)
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            string candidate = Path.Combine(dir.FullName, "game", "data", name);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException($"game/data/{name} not found above {AppContext.BaseDirectory}");
    }
}
