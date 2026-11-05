namespace Survact.Sim.Systems;

internal static class ClimateSystem
{
    public static void Run(Simulation sim)
    {
        float days = sim.Tick / (float)SimBalance.TicksPerDay;
        float baseTemp = SimBalance.StartTemperature - SimBalance.TemperatureDropPerDay * days;
        float swing = SimBalance.DailySwing * MathF.Sin(MathF.Tau * (sim.TimeOfDay - 0.3f));
        sim.Temperature = MathF.Max(SimBalance.MinTemperature, baseTemp + swing);
    }
}

internal static class HeaterSystem
{
    public static void Run(Simulation sim)
    {
        var colony = sim.Colony;
        float deficit = SimBalance.ComfortTemperature - sim.Temperature;
        if (!colony.HeaterLit || deficit <= 0) return;

        colony.BurnAccumulator += deficit * SimBalance.HeaterBurnPerDegreeTick;
        int whole = (int)colony.BurnAccumulator;
        if (whole == 0) return;

        colony.BurnAccumulator -= whole;
        colony.Wood = Math.Max(0, colony.Wood - whole);
    }
}
