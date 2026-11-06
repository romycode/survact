using Survact.Sim.Buildings;
using Survact.Sim.Entities;

namespace Survact.Sim.Systems;

/// <summary>
/// The one place that undoes a colonist's job bookkeeping: tile reservations, wood in transit,
/// builder slots, shelter slots. Used on death, when a path becomes invalid, when a site is
/// cancelled and when a job ends normally. Keeping it in one place is what keeps the counters honest.
/// </summary>
internal static class Jobs
{
    public static void Release(Simulation sim, int i)
    {
        var c = sim.Colonists;

        if (c.Target[i] >= 0)
        {
            sim.Map.Release(c.Target[i]);
            c.Target[i] = -1;
        }

        int site = c.Site[i];
        if (site >= 0)
        {
            ref var b = ref sim.Buildings[site];
            switch (c.Job[i])
            {
                case Job.Haul when c.Carry[i] > 0:
                    // Wood in transit goes back to the stockpile (abstracted: no dropped piles yet).
                    b.WoodIncoming -= c.Carry[i];
                    sim.Colony.Wood += c.Carry[i];
                    break;
                case Job.Haul:
                    b.Haulers--;
                    break;
                case Job.Build:
                    b.Builders--;
                    break;
                case Job.Shelter:
                    b.Occupants--;
                    break;
            }
            c.Site[i] = -1;
        }

        if (c.Job[i] is Job.Haul) c.Carry[i] = 0;
    }

    /// <summary>Releases everything and puts the colonist back to Idle (optionally with a think cooldown).</summary>
    public static void ToIdle(Simulation sim, int i, int cooldown = 0)
    {
        Release(sim, i);
        var c = sim.Colonists;
        c.Job[i] = Job.None;
        c.State[i] = ColonistState.Idle;
        c.Nav[i] = Nav.Path;
        c.PathLength[i] = 0;
        c.PathPos[i] = 0;
        c.Carry[i] = 0;
        c.Timer[i] = cooldown;
    }

    /// <summary>A* to a building's entrance, written into the colonist's path slice.</summary>
    public static bool PathToEntrance(Simulation sim, int i, int buildingId)
    {
        var c = sim.Colonists;
        ref var b = ref sim.Buildings[buildingId];
        var (ex, ey) = BuildingStore.EntranceOf(b, sim.Data.Buildings[b.Type]);
        var map = sim.Map;
        int start = map.Index((int)c.X[i], (int)c.Y[i]);
        int goal = map.Index(ex, ey);

        int length = start == goal ? 0 : sim.Pathfinder.FindPath(start, goal, sim.Balance.SearchMaxNodes, c.PathSlice(i));
        if (length < 0) return false;

        c.Nav[i] = Nav.Path;
        c.PathLength[i] = length;
        c.PathPos[i] = 0;
        c.State[i] = ColonistState.Walking;
        return true;
    }
}
