namespace Survact.Sim.Systems;

/// <summary>Hot loop over plain arrays: this is the shape every per-entity system should have.</summary>
internal static class NeedsSystem
{
    public static void Run(Simulation sim)
    {
        var c = sim.Colonists;
        var colony = sim.Colony;
        int n = c.Count;
        float coldDeficit = MathF.Max(0, SimBalance.ComfortTemperature - sim.Temperature);
        float coldLoss = coldDeficit * SimBalance.ColdLossPerDegreeTick;
        bool heaterLit = colony.HeaterLit;

        float[] hunger = c.Hunger, warmth = c.Warmth, x = c.X, y = c.Y;

        for (int i = 0; i < n; i++)
        {
            hunger[i] = MathF.Max(0, hunger[i] - SimBalance.HungerPerTick);

            float w = warmth[i];
            if (heaterLit && colony.InHeatRange(x[i], y[i])) w += SimBalance.HeaterWarmthPerTick;
            else if (coldLoss > 0) w -= coldLoss;
            else w += SimBalance.AmbientRecoveryPerTick;
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

            if (c.Target[i] >= 0) sim.Map.Release(c.Target[i]);
            sim.Colony.Deaths++;
            c.RemoveAt(i);
        }

        if (c.Count > 0) sim.ThinkCursor %= c.Count;
        else sim.ThinkCursor = 0;
    }
}
