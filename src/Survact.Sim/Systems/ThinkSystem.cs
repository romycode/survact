using Survact.Sim.Entities;
using Survact.Sim.Pathfinding;
using Survact.Sim.World;

namespace Survact.Sim.Systems;

/// <summary>
/// Decision making for idle colonists.
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
