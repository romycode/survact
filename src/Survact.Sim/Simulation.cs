using Survact.Sim.Entities;
using Survact.Sim.Pathfinding;
using Survact.Sim.Systems;
using Survact.Sim.World;

namespace Survact.Sim;

public sealed record SimSettings(uint Seed, int Width = 256, int Height = 256, int InitialColonists = 20);

/// <summary>
/// The whole game state plus a fixed-step <see cref="Step"/>. No engine types, no wall clock,
/// no System.Random: given the same settings and inputs it produces the same result every time.
/// </summary>
public sealed class Simulation
{
    public const int TicksPerSecond = SimBalance.TicksPerSecond;
    public const int TicksPerDay = SimBalance.TicksPerDay;

    public SimSettings Settings { get; }
    public TileMap Map { get; }
    public Colonists Colonists { get; }
    public ColonyState Colony { get; }

    public long Tick { get; internal set; }
    public float Temperature { get; internal set; }

    internal Pcg32 Rng { get; }
    internal GridPathfinder Pathfinder { get; }
    public Regions Regions { get; }
    public FlowField StockpileField { get; }
    internal int ThinkCursor;

    /// <summary>
    /// Per chunk and resource kind: tick until which searching from that chunk is pointless because
    /// a full search just failed there. Turns thousands of identical failed searches into one.
    /// </summary>
    internal long[] SearchExhaustedUntil { get; }

    public int Day => (int)(Tick / TicksPerDay);
    public float TimeOfDay => (Tick % TicksPerDay) / (float)TicksPerDay;
    public long PathQueries => Pathfinder.Queries;
    public long PathFailures => Pathfinder.Failed;
    public long FieldRebuilds => StockpileField.Rebuilds;
    public long PathNodesExpanded => Pathfinder.Expanded;

    internal Simulation(SimSettings settings, TileMap map, Colonists colonists, ColonyState colony, Pcg32 rng)
    {
        Settings = settings;
        Map = map;
        Colonists = colonists;
        Colony = colony;
        Rng = rng;
        Pathfinder = new GridPathfinder(map);
        Regions = new Regions(map);
        SearchExhaustedUntil = new long[map.ChunksX * map.ChunksY * 2];
        StockpileField = new FlowField(map);
        StockpileField.SetTarget(map.Index(colony.StockX, colony.StockY));
    }

    public static Simulation Create(SimSettings settings)
    {
        var map = new TileMap(settings.Width, settings.Height);
        WorldGen.Generate(map, settings.Seed);

        // Start on the biggest landmass, as close to the centre as possible.
        int start = NearestTileInLargestRegion(map, settings.Width / 2, settings.Height / 2);
        var colony = new ColonyState
        {
            StockX = map.X(start),
            StockY = map.Y(start),
            Wood = SimBalance.StartWood,
            Food = SimBalance.StartFood,
        };
        WorldGen.ClearArea(map, colony.StockX, colony.StockY, clearRadius: 5);

        var rng = new Pcg32(settings.Seed);
        var sim = new Simulation(settings, map, new Colonists(settings.InitialColonists), colony, rng);

        for (int n = 0; n < settings.InitialColonists; n++)
        {
            int x = colony.StockX + rng.Next(9) - 4;
            int y = colony.StockY + rng.Next(9) - 4;
            sim.Colonists.Spawn(x + 0.5f, y + 0.5f);
        }

        ClimateSystem.Run(sim);
        return sim;
    }

    private static int NearestTileInLargestRegion(TileMap map, int cx, int cy)
    {
        var regions = new Regions(map);
        int largest = regions.Largest();
        if (largest == Regions.None) return map.Index(cx, cy);

        int maxR = Math.Max(map.Width, map.Height);
        for (int r = 0; r < maxR; r++)
        for (int dy = -r; dy <= r; dy++)
        for (int dx = -r; dx <= r; dx++)
        {
            if (Math.Max(Math.Abs(dx), Math.Abs(dy)) != r) continue;
            int x = cx + dx, y = cy + dy;
            if (!map.InBounds(x, y)) continue;
            int idx = map.Index(x, y);
            if (regions.Of(idx) == largest) return idx;
        }
        return map.Index(cx, cy);
    }

    /// <summary>Advances the world by exactly one tick. System order is part of the contract.</summary>
    public void Step()
    {
        Colonists.SnapshotPrevious();

        var p = Profiler;
        if (p is null)
        {
            ClimateSystem.Run(this);
            HeaterSystem.Run(this);
            NeedsSystem.Run(this);
            ThinkSystem.Run(this);
            MovementSystem.Run(this);
            WorkSystem.Run(this);
            DeathSystem.Run(this);
        }
        else
        {
            p.Run(0, this, ClimateSystem.Run);
            p.Run(1, this, HeaterSystem.Run);
            p.Run(2, this, NeedsSystem.Run);
            p.Run(3, this, ThinkSystem.Run);
            p.Run(4, this, MovementSystem.Run);
            p.Run(5, this, WorkSystem.Run);
            p.Run(6, this, DeathSystem.Run);
        }

        Tick++;
    }

    /// <summary>Optional per-system timing. Observes wall time only; never affects state.</summary>
    public SystemProfiler? Profiler { get; set; }

    public void Step(int ticks)
    {
        for (int i = 0; i < ticks; i++) Step();
    }

    /// <summary>Hash of the full simulation state. Equal hashes = identical worlds.</summary>
    public ulong StateHash() => Persistence.StateHasher.Hash(this);
}
