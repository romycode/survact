using Survact.Sim.Entities;

namespace Survact.Sim.Systems;

internal static class WorkSystem
{
    public static void Run(Simulation sim)
    {
        var c = sim.Colonists;
        var colony = sim.Colony;
        int n = c.Count;

        for (int i = 0; i < n; i++)
        {
            switch (c.State[i])
            {
                case ColonistState.Gathering:
                    if (--c.Timer[i] > 0) break;
                    FinishGather(sim, i);
                    break;

                case ColonistState.Eating:
                    if (--c.Timer[i] > 0) break;
                    if (colony.Food > 0)
                    {
                        colony.Food--;
                        c.Hunger[i] = 1f;
                    }
                    ToIdle(c, i);
                    break;

                case ColonistState.Warming:
                    if (!colony.HeaterLit || c.Warmth[i] >= SimBalance.WarmEnough) ToIdle(c, i);
                    break;
            }
        }
    }

    private static void FinishGather(Simulation sim, int i)
    {
        var c = sim.Colonists;
        int target = c.Target[i];
        int taken = sim.Map.Take(target, SimBalance.CarryCapacity);
        sim.Map.Release(target);
        c.Target[i] = -1;
        c.Carry[i] = taken;

        if (taken == 0)
        {
            ToIdle(c, i);
            return;
        }

        // Hauling back follows the shared flow field: no search, no budget needed.
        ThinkSystem.GoToStockpile(sim, i, c.Job[i], within: 1);
    }

    private static void ToIdle(Colonists c, int i)
    {
        c.Job[i] = Job.None;
        c.State[i] = ColonistState.Idle;
        c.Timer[i] = 0;
    }
}
