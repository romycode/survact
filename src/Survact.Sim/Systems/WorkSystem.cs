using Survact.Sim.Buildings;
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
                    if (!colony.HeaterLit || c.Warmth[i] >= sim.Balance.WarmEnough) ToIdle(c, i);
                    break;

                case ColonistState.Constructing:
                {
                    ref var b = ref sim.Buildings[c.Site[i]];
                    // Needs first: a builder stops to eat or warm up (and can come back later).
                    bool needsBreak = (c.Hunger[i] < sim.Balance.EatThreshold && colony.Food > 0)
                                      || (c.Warmth[i] < sim.Balance.WarmThreshold && colony.HeaterLit);
                    if (b.Stage != BuildingStage.Site || needsBreak) Jobs.ToIdle(sim, i);
                    else b.Work++;
                    break;
                }

                case ColonistState.Sheltered:
                {
                    // Leave at dawn, earlier to eat, or to warm up at the heater if this shelter is too cold.
                    bool hungry = c.Hunger[i] < sim.Balance.EatThreshold && colony.Food > 0;
                    bool freezing = c.Warmth[i] < sim.Balance.WarmThreshold && colony.HeaterLit
                                    && sim.ShelterTemperature(c.Site[i]) < sim.Balance.ComfortTemperature;
                    if (!sim.IsNight || hungry || freezing) Jobs.ToIdle(sim, i);
                    break;
                }
            }
        }
    }

    private static void FinishGather(Simulation sim, int i)
    {
        var c = sim.Colonists;
        int target = c.Target[i];
        int taken = sim.Map.Take(target, sim.Balance.CarryCapacity);
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
