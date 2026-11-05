namespace Survact.Sim.Systems;

internal static class ClimateSystem
{
    public static void Run(Simulation sim)
    {
        var b = sim.Balance;
        float days = sim.Tick / (float)b.TicksPerDay;
        float baseTemp = b.StartTemperature - b.TemperatureDropPerDay * days;
        float swing = b.DailySwing * MathF.Sin(MathF.Tau * (sim.TimeOfDay - 0.3f));
        sim.Temperature = MathF.Max(b.MinTemperature, baseTemp + swing) + sim.ClimateOffset;
    }
}

internal static class HeaterSystem
{
    public static void Run(Simulation sim)
    {
        var colony = sim.Colony;
        float deficit = sim.Balance.ComfortTemperature - sim.Temperature;
        if (!colony.HeaterLit || deficit <= 0) return;

        colony.BurnAccumulator += deficit * sim.Balance.HeaterBurnPerDegreeTick;
        int whole = (int)colony.BurnAccumulator;
        if (whole == 0) return;

        colony.BurnAccumulator -= whole;
        colony.Wood = Math.Max(0, colony.Wood - whole);
    }
}
