using Survact.Sim.Buildings;

namespace Survact.Sim.Systems;

/// <summary>Turns fully built sites into buildings. Builders notice the stage change in WorkSystem next tick.</summary>
internal static class ConstructionSystem
{
    public static void Run(Simulation sim)
    {
        var store = sim.Buildings;
        for (int id = 0; id < store.Count; id++)
        {
            ref var b = ref store[id];
            if (b.Stage != BuildingStage.Site) continue;
            var t = sim.Data.Buildings[b.Type];
            if (b.Wood < t.WoodCost || b.Work < t.BuildTicks) continue;
            b.Stage = BuildingStage.Built;
            store.Version++;
        }
    }
}
