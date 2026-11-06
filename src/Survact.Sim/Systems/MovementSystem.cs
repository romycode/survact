using Survact.Sim.Buildings;
using Survact.Sim.Entities;

namespace Survact.Sim.Systems;

internal static class MovementSystem
{
    public static void Run(Simulation sim)
    {
        var c = sim.Colonists;
        int n = c.Count;

        for (int i = 0; i < n; i++)
        {
            if (c.State[i] != ColonistState.Walking) continue;

            bool arrived = c.Nav[i] == Nav.Path ? StepPath(sim, i) : StepStockpile(sim, i);
            if (arrived && c.State[i] == ColonistState.Walking) Arrive(sim, i);
        }
    }

    /// <summary>Follows the stored path. Returns true when the end is reached.</summary>
    private static bool StepPath(Simulation sim, int i)
    {
        var c = sim.Colonists;
        int width = sim.Map.Width;
        int pathBase = i * Colonists.MaxPathLength;
        float budget = sim.Balance.MoveSpeedTilesPerTick;

        while (budget > 0 && c.PathPos[i] < c.PathLength[i])
        {
            int node = c.Path[pathBase + c.PathPos[i]];

            // The world changes under stored paths (a building is placed, a cliff appears later):
            // re-check each step and give up cleanly instead of walking through walls.
            int from = c.PathPos[i] == 0 ? sim.Map.Index((int)c.X[i], (int)c.Y[i]) : c.Path[pathBase + c.PathPos[i] - 1];
            if (from != node && !sim.Map.CanStep(from, node))
            {
                Jobs.ToIdle(sim, i, sim.Balance.FailedPathCooldownTicks);
                return false;
            }

            if (MoveToward(c, i, node % width + 0.5f, node / width + 0.5f, ref budget)) c.PathPos[i]++;
        }
        return c.PathPos[i] >= c.PathLength[i];
    }

    /// <summary>
    /// Descends the stockpile flow field one tile at a time. The tile being walked to is kept in
    /// path slot 0 (PathLength 1 = step in progress): deriving it from the float position would
    /// backtrack when moving in negative directions. Arrives within Timer tiles (Chebyshev).
    /// </summary>
    private static bool StepStockpile(Simulation sim, int i)
    {
        var c = sim.Colonists;
        var map = sim.Map;
        var colony = sim.Colony;
        int slot = i * Colonists.MaxPathLength;
        float budget = sim.Balance.MoveSpeedTilesPerTick;

        while (budget > 0)
        {
            if (c.PathLength[i] == 0)
            {
                // At a tile centre: arrived, or pick the next downhill tile.
                int tx = (int)c.X[i], ty = (int)c.Y[i];
                if (Math.Max(Math.Abs(tx - colony.StockX), Math.Abs(ty - colony.StockY)) <= c.Timer[i]) return true;

                int next = sim.StockpileField.Next(map.Index(tx, ty));
                if (next < 0) return true;
                c.Path[slot] = next;
                c.PathLength[i] = 1;
            }

            int node = c.Path[slot];
            if (MoveToward(c, i, map.X(node) + 0.5f, map.Y(node) + 0.5f, ref budget)) c.PathLength[i] = 0;
        }
        return false;
    }

    /// <summary>At the stockpile with a haul job: take what the site still needs, then path to it.</summary>
    private static void PickUpForSite(Simulation sim, int i)
    {
        var c = sim.Colonists;
        ref var b = ref sim.Buildings[c.Site[i]];
        var t = sim.Data.Buildings[b.Type];
        int need = t.WoodCost - b.Wood - b.WoodIncoming;
        int take = Math.Min(Math.Min(need, sim.Balance.CarryCapacity), sim.Colony.Wood);
        if (b.Stage != BuildingStage.Site || take <= 0)
        {
            Jobs.ToIdle(sim, i); // releases the hauler claim
            return;
        }

        b.Haulers--; // claim becomes wood in transit
        sim.Colony.Wood -= take;
        b.WoodIncoming += take;
        c.Carry[i] = take;
        if (!Jobs.PathToEntrance(sim, i, c.Site[i]))
            Jobs.ToIdle(sim, i, sim.Balance.FailedPathCooldownTicks); // refunds the wood
    }

    /// <summary>Moves toward a point spending budget. Returns true when the point is reached.</summary>
    private static bool MoveToward(Colonists c, int i, float tx, float ty, ref float budget)
    {
        float dx = tx - c.X[i], dy = ty - c.Y[i];
        float dist = MathF.Sqrt(dx * dx + dy * dy);
        if (dist <= budget)
        {
            c.X[i] = tx;
            c.Y[i] = ty;
            budget -= dist;
            return true;
        }

        c.X[i] += dx / dist * budget;
        c.Y[i] += dy / dist * budget;
        budget = 0;
        return false;
    }

    private static void Arrive(Simulation sim, int i)
    {
        var c = sim.Colonists;
        c.Nav[i] = Nav.Path;
        c.Timer[i] = 0;

        switch (c.Job[i])
        {
            case Job.Haul when c.Carry[i] == 0:
                PickUpForSite(sim, i);
                break;

            case Job.Haul:
            {
                ref var b = ref sim.Buildings[c.Site[i]];
                b.Wood += c.Carry[i];
                b.WoodIncoming -= c.Carry[i];
                c.Carry[i] = 0;
                c.Site[i] = -1; // delivered: nothing left to release
                Jobs.ToIdle(sim, i);
                break;
            }

            case Job.Build:
                c.State[i] = ColonistState.Constructing;
                break;

            case Job.Shelter:
                c.State[i] = ColonistState.Sheltered;
                break;

            case Job.Eat:
                c.State[i] = ColonistState.Eating;
                c.Timer[i] = sim.Balance.EatTicks;
                break;

            case Job.Warm:
                c.State[i] = ColonistState.Warming;
                break;

            case Job.Wood or Job.Food when c.Carry[i] == 0:
                c.State[i] = ColonistState.Gathering;
                c.Timer[i] = sim.Balance.GatherTicks;
                break;

            case Job.Wood or Job.Food:
                if (c.Job[i] == Job.Wood) sim.Colony.Wood += c.Carry[i];
                else sim.Colony.Food += c.Carry[i];
                c.Carry[i] = 0;
                c.Job[i] = Job.None;
                c.State[i] = ColonistState.Idle;
                break;

            default:
                c.State[i] = ColonistState.Idle;
                break;
        }
    }
}
