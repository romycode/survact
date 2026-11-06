using Survact.Sim.Entities;

namespace Survact.Sim.Systems;

/// <summary>Hot loop over plain arrays: this is the shape every per-entity system should have.</summary>
internal static class NeedsSystem
{
    public static void Run(Simulation sim)
    {
        var c = sim.Colonists;
        var colony = sim.Colony;
        int n = c.Count;
        var map = sim.Map;
        float comfortGap = sim.Balance.ComfortTemperature - sim.Temperature;
        float lapse = sim.Balance.LapseRatePerLevel;
        float lossPerDegree = sim.Balance.ColdLossPerDegreeTick;
        bool heaterLit = colony.HeaterLit;
        int heatRadius = sim.Balance.HeatRadius;

        float[] hunger = c.Hunger, warmth = c.Warmth, x = c.X, y = c.Y;

        for (int i = 0; i < n; i++)
        {
            hunger[i] = MathF.Max(0, hunger[i] - sim.Balance.HungerPerTick);

            // Higher up is colder: the temperature a colonist feels drops with its terrain level.
            // Inside a shelter the building's insulation is added on top.
            float gap = comfortGap + lapse * map.LevelAt((int)x[i], (int)y[i]);
            bool sheltered = c.State[i] == ColonistState.Sheltered;
            if (sheltered)
            {
                ref var b = ref sim.Buildings[c.Site[i]];
                gap -= sim.ShelterWarmth(b.Type, b.X, b.Y);
            }
            float coldLoss = MathF.Max(0, gap) * lossPerDegree;

            float w = warmth[i];
            if (!sheltered && heaterLit && colony.InHeatRange(x[i], y[i], heatRadius)) w += sim.Balance.HeaterWarmthPerTick;
            else if (coldLoss > 0) w -= coldLoss;
            else w += sim.Balance.AmbientRecoveryPerTick;
            warmth[i] = Math.Clamp(w, 0f, 1f);
        }
    }
}

internal static class DeathSystem
{
    public static void Run(Simulation sim)
    {
        var c = sim.Colonists;
        // Backwards: swap-remove pulls the last element into i, which was already checked.
        for (int i = c.Count - 1; i >= 0; i--)
        {
            if (c.Hunger[i] > 0 && c.Warmth[i] > 0) continue;

            Jobs.Release(sim, i);
            sim.Colony.Deaths++;
            c.RemoveAt(i);
        }

        if (c.Count > 0) sim.ThinkCursor %= c.Count;
        else sim.ThinkCursor = 0;
    }
}
