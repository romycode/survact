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
    ("buildings: placement rules reject bad spots", PlacementRules),
    ("buildings: colonists haul wood and build", ConstructionEndToEnd),
    ("buildings: cancelling a site refunds and unblocks", CancelSite),
    ("buildings: shelters keep colonists warmer through the night", SheltersSaveLives),
    ("buildings: save/load and replay mid-construction", BuildingsSaveAndReplay),
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

static (int X, int Y) FindSpot(Simulation sim, int type, int minDistance = 3)
{
    var colony = sim.Colony;
    for (int r = minDistance; r < 40; r++)
    for (int dy = -r; dy <= r; dy++)
    for (int dx = -r; dx <= r; dx++)
    {
        if (Math.Max(Math.Abs(dx), Math.Abs(dy)) != r) continue;
        int x = colony.StockX + dx, y = colony.StockY + dy;
        if (Survact.Sim.Buildings.BuildRules.Check(sim, type, x, y) == Survact.Sim.Buildings.PlacementError.None) return (x, y);
    }
    throw new Exception("no valid building spot near the stockpile");
}

static void CheckBuildingCounters(Simulation sim)
{
    var c = sim.Colonists;
    for (int id = 0; id < sim.Buildings.Count; id++)
    {
        ref var b = ref sim.Buildings[id];
        int haulers = 0, incoming = 0, builders = 0, occupants = 0;
        for (int i = 0; i < c.Count; i++)
        {
            if (c.Site[i] != id) continue;
            switch (c.Job[i])
            {
                case Survact.Sim.Entities.Job.Haul when c.Carry[i] > 0: incoming += c.Carry[i]; break;
                case Survact.Sim.Entities.Job.Haul: haulers++; break;
                case Survact.Sim.Entities.Job.Build: builders++; break;
                case Survact.Sim.Entities.Job.Shelter: occupants++; break;
            }
        }
        Assert(b.Haulers == haulers && b.WoodIncoming == incoming && b.Builders == builders && b.Occupants == occupants,
            $"building #{id} counters drifted: haulers {b.Haulers}/{haulers} incoming {b.WoodIncoming}/{incoming} builders {b.Builders}/{builders} occupants {b.Occupants}/{occupants}");
    }

    // Nobody stands inside a building footprint while walking (sheltered colonists wait at the entrance).
    for (int i = 0; i < c.Count; i++)
    {
        if (c.State[i] != Survact.Sim.Entities.ColonistState.Walking || c.Nav[i] != Survact.Sim.Entities.Nav.Path) continue;
        var path = c.PathSlice(i);
        for (int k = c.PathPos[i]; k < c.PathLength[i]; k++)
            Assert(sim.Map.BuildingAt(path[k]) < 0, $"colonist {i} has a path through building #{sim.Map.BuildingAt(path[k])}");
    }
}

static void PlacementRules()
{
    var sim = Simulation.Create(new SimSettings(Seed: 1337, InitialColonists: 10), TestData.Game);
    var map = sim.Map;
    int cabin = sim.Data.Buildings.IndexOf("cabin");
    int tent = sim.Data.Buildings.IndexOf("tent");
    Assert(cabin >= 0 && tent >= 0, "tent/cabin missing from data");

    var colony = sim.Colony;
    Assert(Survact.Sim.Buildings.BuildRules.Check(sim, tent, colony.StockX, colony.StockY) == Survact.Sim.Buildings.PlacementError.TooCloseToHeater, "heater tile accepted");
    Assert(Survact.Sim.Buildings.BuildRules.Check(sim, cabin, map.Width - 1, 3) == Survact.Sim.Buildings.PlacementError.OutOfBounds, "out of bounds accepted");
    Assert(Survact.Sim.Buildings.BuildRules.Check(sim, 99, 10, 10) == Survact.Sim.Buildings.PlacementError.UnknownType, "unknown type accepted");

    int water = -1, tree = -1;
    for (int i = 0; i < map.Count && (water < 0 || tree < 0); i++)
    {
        int x = map.X(i), y = map.Y(i);
        if (x < 2 || y < 2 || x > map.Width - 4 || y > map.Height - 4) continue;
        if (water < 0 && map.Get(i) == Survact.Sim.World.Tile.Water) water = i;
        if (tree < 0 && map.Get(i) == Survact.Sim.World.Tile.Tree) tree = i;
    }
    Assert(Survact.Sim.Buildings.BuildRules.Check(sim, tent, map.X(water), map.Y(water)) == Survact.Sim.Buildings.PlacementError.NotClearGround, "water accepted");
    Assert(Survact.Sim.Buildings.BuildRules.Check(sim, tent, map.X(tree), map.Y(tree)) == Survact.Sim.Buildings.PlacementError.NotClearGround, "tree accepted");

    var (cx, cy) = FindSpot(sim, cabin);
    sim.Enqueue(Command.PlaceBuilding(cabin, cx, cy));
    sim.Enqueue(Command.PlaceBuilding(tent, cx + 1, cy)); // overlaps the cabin
    var rejected = new List<string>();
    sim.CommandRejected += (_, reason) => rejected.Add(reason);
    sim.Step();
    Assert(sim.Buildings.Count == 1, $"expected 1 building, got {sim.Buildings.Count}");
    Assert(rejected.Count == 1 && rejected[0].Contains("Occupied"), $"overlap not rejected as Occupied: {string.Join(";", rejected)}");
    Assert(sim.CommandLog.Count == 1, "rejected placement entered the replay log");
    for (int ty = cy; ty < cy + 2; ty++)
    for (int tx = cx; tx < cx + 2; tx++)
        Assert(map.BuildingAt(map.Index(tx, ty)) == 0, "cabin footprint not occupied");
}

static void ConstructionEndToEnd()
{
    var sim = Simulation.Create(new SimSettings(Seed: 1337, InitialColonists: 20), TestData.Game);
    int cabin = sim.Data.Buildings.IndexOf("cabin");
    int tent = sim.Data.Buildings.IndexOf("tent");
    var (cx, cy) = FindSpot(sim, cabin, 4);
    sim.Enqueue(Command.PlaceBuilding(cabin, cx, cy));
    sim.Step();
    var (tx, ty) = FindSpot(sim, tent, 3);
    sim.Enqueue(Command.PlaceBuilding(tent, tx, ty));

    for (int t = 0; t < sim.Balance.TicksPerDay / 2 && !AllBuilt(sim); t++)
    {
        sim.Step();
        if (t % 300 == 0) CheckBuildingCounters(sim);
    }
    Assert(AllBuilt(sim), $"buildings not finished in half a day: {Describe(sim)}");

    sim.Step(5); // builders notice completion and go idle
    CheckBuildingCounters(sim);
    for (int id = 0; id < sim.Buildings.Count; id++)
    {
        ref var b = ref sim.Buildings[id];
        var t = sim.Data.Buildings[b.Type];
        Assert(b.Wood == t.WoodCost && b.WoodIncoming == 0 && b.Builders == 0 && b.Haulers == 0, $"leftover counters on #{id}: {Describe(sim)}");
    }

    static bool AllBuilt(Simulation sim)
    {
        for (int id = 0; id < sim.Buildings.Count; id++)
            if (sim.Buildings[id].Stage != Survact.Sim.Buildings.BuildingStage.Built) return false;
        return sim.Buildings.Count == 2;
    }
}

static string Describe(Simulation sim)
{
    var parts = new List<string>();
    for (int id = 0; id < sim.Buildings.Count; id++)
    {
        ref var b = ref sim.Buildings[id];
        parts.Add($"#{id} {sim.Data.Buildings[b.Type].Name} {b.Stage} wood {b.Wood}+{b.WoodIncoming} haulers {b.Haulers} work {b.Work}/{sim.Data.Buildings[b.Type].BuildTicks} builders {b.Builders}");
    }
    return string.Join("; ", parts) + $"; stock wood {sim.Colony.Wood}";
}

static void CancelSite()
{
    var sim = Simulation.Create(new SimSettings(Seed: 1337, InitialColonists: 20), TestData.Game);
    int cabin = sim.Data.Buildings.IndexOf("cabin");
    var (cx, cy) = FindSpot(sim, cabin, 4);
    sim.Enqueue(Command.PlaceBuilding(cabin, cx, cy));

    // Run until some wood is delivered but the cabin isn't finished.
    for (int t = 0; t < 3000 && sim.Buildings[0].Wood < 10; t++) { if (sim.Buildings.Count == 0) { sim.Step(); continue; } sim.Step(); }
    Assert(sim.Buildings[0].Stage == Survact.Sim.Buildings.BuildingStage.Site && sim.Buildings[0].Wood >= 10, $"setup failed: {Describe(sim)}");

    int totalBefore = sim.Colony.Wood + sim.Buildings[0].Wood + sim.Buildings[0].WoodIncoming;
    sim.Enqueue(Command.CancelBuilding(0));
    sim.Step();
    Assert(sim.Buildings[0].Stage == Survact.Sim.Buildings.BuildingStage.Removed, "site not removed");
    Assert(sim.Map.BuildingAt(sim.Map.Index(cx, cy)) == -1, "footprint still blocked");
    // Wood conserved (allowing for one tick of gathering deliveries / heater burn).
    Assert(Math.Abs(sim.Colony.Wood - totalBefore) <= sim.Balance.CarryCapacity * 4, $"wood not refunded: before {totalBefore}, now {sim.Colony.Wood}");
    CheckBuildingCounters(sim);
    for (int i = 0; i < sim.Colonists.Count; i++) Assert(sim.Colonists.Site[i] == -1, "colonist still bound to a cancelled site");
}

static void SheltersSaveLives()
{
    // Balance doesn't make the cold lethal yet (heater + wood keep everyone alive), so measure the
    // physical effect instead: how warm colonists are at dawn after nights with and without shelter.
    var settings = new SimSettings(Seed: 1337, InitialColonists: 24);
    (double DawnWarmth, int MaxSheltered, int Deaths) Run(bool withShelters)
    {
        var sim = Simulation.Create(settings, TestData.Game);
        int cabin = sim.Data.Buildings.IndexOf("cabin");
        sim.Enqueue(Command.SetClimateOffset(-18f));
        sim.Enqueue(Command.AddStock(wood: 400, food: 800));
        sim.Step();
        if (withShelters)
            for (int k = 0; k < 4; k++)
            {
                var (x, y) = FindSpot(sim, cabin, 3);
                sim.Enqueue(Command.PlaceBuilding(cabin, x, y));
                sim.Step();
            }

        int maxSheltered = 0;
        double dawnSum = 0;
        int dawns = 0;
        int dawnTick = (int)(sim.Balance.NightUntil * sim.Balance.TicksPerDay);
        for (int t = 0; t < sim.Balance.TicksPerDay * 4; t++)
        {
            sim.Step();
            if (sim.Tick % sim.Balance.TicksPerDay == dawnTick && sim.Day >= 1)
            {
                for (int i = 0; i < sim.Colonists.Count; i++) dawnSum += sim.Colonists.Warmth[i];
                dawns += sim.Colonists.Count;
            }
            if (t % 200 != 0) continue;
            int sheltered = 0;
            for (int i = 0; i < sim.Colonists.Count; i++)
                if (sim.Colonists.State[i] == Survact.Sim.Entities.ColonistState.Sheltered) sheltered++;
            maxSheltered = Math.Max(maxSheltered, sheltered);
            CheckBuildingCounters(sim);
        }
        return (dawnSum / Math.Max(1, dawns), maxSheltered, sim.Colony.Deaths);
    }

    var with = Run(true);
    var without = Run(false);
    Console.WriteLine($"      -18°C offset, 3 dawns: mean warmth with 4 cabins {with.DawnWarmth:F2}, without {without.DawnWarmth:F2}; " +
                      $"max sheltered {with.MaxSheltered}; deaths {with.Deaths} vs {without.Deaths}");
    Assert(with.MaxSheltered >= 20, $"shelters barely used at night (max {with.MaxSheltered})");
    Assert(with.DawnWarmth > without.DawnWarmth + 0.05, "shelters didn't keep colonists warmer through the night");
    Assert(with.Deaths <= without.Deaths, "shelters made things worse");
}

static void BuildingsSaveAndReplay()
{
    var settings = new SimSettings(Seed: 77, InitialColonists: 30);
    var live = Simulation.Create(settings, TestData.Game);
    int cabin = live.Data.Buildings.IndexOf("cabin");
    int tent = live.Data.Buildings.IndexOf("tent");
    for (int t = 0; t < 2000; t++)
    {
        if (t == 10) { var (x, y) = FindSpot(live, cabin, 4); live.Enqueue(Command.PlaceBuilding(cabin, x, y)); }
        if (t == 20) { var (x, y) = FindSpot(live, tent, 3); live.Enqueue(Command.PlaceBuilding(tent, x, y)); }
        if (t == 400) live.Enqueue(Command.CancelBuilding(1));
        if (t == 500) { var (x, y) = FindSpot(live, tent, 3); live.Enqueue(Command.PlaceBuilding(tent, x, y)); }
        live.Step();
    }

    using var ms = new MemoryStream();
    SaveGame.Save(live, ms);
    ms.Position = 0;
    var loaded = SaveGame.Load(ms, TestData.Game);
    Assert(loaded.StateHash() == live.StateHash(), "hash differs right after load (buildings)");
    Assert(loaded.Map.BuildingAt(loaded.Map.Index(live.Buildings[0].X, live.Buildings[0].Y)) == 0, "occupancy not rebuilt on load");
    live.Step(3000);
    loaded.Step(3000);
    Assert(loaded.StateHash() == live.StateHash(), "loaded world with buildings diverged");

    var replayed = Simulation.Create(settings, TestData.Game);
    Replay.Run(replayed, live.CommandLog, live.Tick);
    Assert(replayed.StateHash() == live.StateHash(), "replay with building commands diverged");
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
