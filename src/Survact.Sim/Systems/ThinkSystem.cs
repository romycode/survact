using Survact.Sim.Buildings;
using Survact.Sim.Data;
using Survact.Sim.Entities;
using Survact.Sim.Pathfinding;
using Survact.Sim.World;

namespace Survact.Sim.Systems;

/// <summary>
/// Decision making for idle colonists. Priorities: eat → (at night) shelter → warm at the heater →
/// construction (haul wood, then build) → gather.
/// Cost model: going to the stockpile is free (flow field). Finding work is a bounded Dijkstra
/// search, and all searches together share a per-tick node budget, visited round-robin.
/// With 5,000 idle colonists the tick cost stays flat; decisions just spread over more ticks.
/// </summary>
internal static class ThinkSystem
{
    public static void Run(Simulation sim)
    {
        var c = sim.Colonists;
        int n = c.Count;
        if (n == 0) return;

        for (int i = 0; i < n; i++)
            if (c.State[i] == ColonistState.Idle && c.Timer[i] > 0) c.Timer[i]--;

        long budgetEnd = sim.Pathfinder.Expanded + sim.Balance.SearchNodesPerTick;
        int start = sim.ThinkCursor % n;
        int visited = 0;

        for (; visited < n && sim.Pathfinder.Expanded < budgetEnd; visited++)
        {
            int i = (start + visited) % n;
            if (c.State[i] != ColonistState.Idle || c.Timer[i] > 0) continue;
            Decide(sim, i);
        }

        sim.ThinkCursor = (start + visited) % n;
    }

    private static void Decide(Simulation sim, int i)
    {
        var c = sim.Colonists;
        var colony = sim.Colony;

        if (c.Hunger[i] < sim.Balance.EatThreshold && colony.Food > 0)
        {
            GoToStockpile(sim, i, Job.Eat, within: 1);
            return;
        }

        if (sim.IsNight && TryShelter(sim, i)) return;

        if (c.Warmth[i] < sim.Balance.WarmThreshold && colony.HeaterLit)
        {
            if (colony.InHeatRange(c.X[i], c.Y[i], sim.Balance.HeatRadius))
            {
                c.Job[i] = Job.Warm;
                c.State[i] = ColonistState.Warming;
            }
            else
            {
                GoToStockpile(sim, i, Job.Warm, within: sim.Balance.HeatRadius / 2);
            }
            return;
        }

        if (TryConstruction(sim, i)) return;

        bool wantFood = colony.Food < c.Count * sim.Balance.FoodTargetPerColonist
                        || (colony.Wood > colony.Food * 2 && sim.Rng.Next(2) == 0);

        if (TryGather(sim, i, wantFood ? Job.Food : Job.Wood)) return;
        if (TryGather(sim, i, wantFood ? Job.Wood : Job.Food)) return;

        c.Timer[i] = sim.Balance.IdleCooldownTicks;
    }

    private static bool TryGather(Simulation sim, int i, Job job)
    {
        var c = sim.Colonists;
        var map = sim.Map;
        int tx = (int)c.X[i], ty = (int)c.Y[i];
        int start = map.Index(tx, ty);

        int chunk = ty / TileMap.ChunkSize * map.ChunksX + tx / TileMap.ChunkSize;
        int memo = chunk * 2 + (job == Job.Food ? 1 : 0);
        if (sim.Tick < sim.SearchExhaustedUntil[memo]) return false;

        var goal = new ResourceGoal(map, job == Job.Food ? Tile.Bush : Tile.Tree);
        int length = sim.Pathfinder.FindNearest(start, ref goal, sim.Balance.SearchMaxNodes, c.PathSlice(i), out int target);
        if (length < 0)
        {
            sim.SearchExhaustedUntil[memo] = sim.Tick + sim.Balance.ExhaustedSearchMemoTicks;
            return false;
        }

        map.Reserve(target);
        c.Target[i] = target;
        c.Job[i] = job;
        c.Carry[i] = 0;
        c.Nav[i] = Nav.Path;
        c.PathLength[i] = length;
        c.PathPos[i] = 0;
        c.State[i] = ColonistState.Walking;
        return true;
    }

    /// <summary>Night: the nearest reachable built shelter with a free slot. Reserves the slot.</summary>
    private static bool TryShelter(Simulation sim, int i)
    {
        int best = FindNearestBuilding(sim, i, static (sim, id, ref b, t) =>
            b.Stage == BuildingStage.Built && t.IsShelter && b.Occupants < t.ShelterCapacity);
        if (best < 0) return false;

        var c = sim.Colonists;
        if (!Jobs.PathToEntrance(sim, i, best)) return false;
        sim.Buildings[best].Occupants++;
        c.Site[i] = best;
        c.Job[i] = Job.Shelter;
        return true;
    }

    /// <summary>
    /// Construction comes before gathering: first deliver missing wood (if the stockpile has any),
    /// then work on fully supplied sites, up to max_builders each.
    /// </summary>
    private static bool TryConstruction(Simulation sim, int i)
    {
        var c = sim.Colonists;

        if (sim.Colony.Wood > 0)
        {
            int haul = FindNearestBuilding(sim, i, static (sim, id, ref b, t) =>
                b.Stage == BuildingStage.Site
                && b.Wood + b.WoodIncoming + b.Haulers * sim.Balance.CarryCapacity < t.WoodCost);
            if (haul >= 0)
            {
                // Claim now (so others pick another site), fetch wood at the stockpile, then path to the site.
                GoToStockpile(sim, i, Job.Haul, within: 1);
                if (c.Job[i] != Job.Haul) return false; // stockpile unreachable
                c.Site[i] = haul;
                sim.Buildings[haul].Haulers++;
                return true;
            }
        }

        int build = FindNearestBuilding(sim, i, static (sim, id, ref b, t) =>
            b.Stage == BuildingStage.Site && b.Wood >= t.WoodCost && b.Builders < t.MaxBuilders);
        if (build < 0) return false;
        if (!Jobs.PathToEntrance(sim, i, build)) return false;
        sim.Buildings[build].Builders++;
        c.Site[i] = build;
        c.Job[i] = Job.Build;
        return true;
    }

    private delegate bool BuildingFilter(Simulation sim, int id, ref Building b, BuildingType type);

    /// <summary>
    /// Nearest (Manhattan to the entrance) building passing the filter whose entrance is in the
    /// colonist's region. Linear in building count: fine for hundreds; index by chunk if it grows.
    /// </summary>
    private static int FindNearestBuilding(Simulation sim, int i, BuildingFilter filter)
    {
        var c = sim.Colonists;
        var map = sim.Map;
        int cx = (int)c.X[i], cy = (int)c.Y[i];
        int here = map.Index(cx, cy);
        int best = -1, bestDist = int.MaxValue;
        var store = sim.Buildings;
        if (store.Count == 0) return -1;

        for (int id = 0; id < store.Count; id++)
        {
            ref var b = ref store[id];
            var t = sim.Data.Buildings[b.Type];
            if (!filter(sim, id, ref b, t)) continue;
            var (ex, ey) = BuildingStore.EntranceOf(b, t);
            int d = Math.Abs(ex - cx) + Math.Abs(ey - cy);
            if (d >= bestDist || !sim.Regions.Connected(here, map.Index(ex, ey))) continue;
            best = id;
            bestDist = d;
        }
        return best;
    }

    /// <summary>
    /// Free: walks the shared flow field. <paramref name="within"/> = stop once this close (Chebyshev)
    /// to the stockpile, so arrivals spread around it instead of stacking on one tile.
    /// </summary>
    internal static void GoToStockpile(Simulation sim, int i, Job job, int within)
    {
        var c = sim.Colonists;
        int here = sim.Map.Index((int)c.X[i], (int)c.Y[i]);

        c.Job[i] = job;
        if (sim.StockpileField.DistanceAt(here) == FlowField.Unreachable)
        {
            c.Job[i] = Job.None;
            c.State[i] = ColonistState.Idle;
            c.Timer[i] = sim.Balance.FailedPathCooldownTicks;
            return;
        }

        c.Nav[i] = Nav.Stockpile;
        c.Timer[i] = within;
        c.PathLength[i] = 0;
        c.PathPos[i] = 0;
        c.State[i] = ColonistState.Walking;
    }

    private readonly struct ResourceGoal(TileMap map, Tile wanted) : ISearchGoal
    {
        public bool IsGoal(int index) =>
            map.Get(index) == wanted && map.AmountAt(index) > 0 && !map.IsReserved(index);

        public int Heuristic(int index) => 0;
    }
}
