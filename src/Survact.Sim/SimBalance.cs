namespace Survact.Sim;

/// <summary>
/// Every tuning number in one place. Rates are per tick (see Simulation.TicksPerSecond / TicksPerDay).
/// Later: load from data files so balance changes don't need a recompile.
/// </summary>
public static class SimBalance
{
    // Time
    public const int TicksPerSecond = 30;
    public const int TicksPerDay = TicksPerSecond * 60 * 4; // 4 real minutes per day at x1

    // Climate: base temperature drops every day; daily sine wave on top.
    public const float StartTemperature = 6f;
    public const float TemperatureDropPerDay = 3f;
    public const float DailySwing = 5f;
    public const float MinTemperature = -45f;
    public const float ComfortTemperature = 10f;

    // Needs
    public const float HungerPerTick = 1f / (TicksPerDay * 1.5f);
    public const float ColdLossPerDegreeTick = 1f / (TicksPerDay * 0.6f * 30f);
    public const float HeaterWarmthPerTick = 0.0015f;
    public const float AmbientRecoveryPerTick = 0.0002f;
    public const float EatThreshold = 0.35f;
    public const float WarmThreshold = 0.35f;
    public const float WarmEnough = 0.95f;

    // Heater: wood burned per tick per degree below comfort.
    public const float HeaterBurnPerDegreeTick = 0.0003f;

    // Work
    public const float MoveSpeedTilesPerTick = 3f / TicksPerSecond;
    public const int GatherTicks = 90;
    public const int EatTicks = 60;
    public const int CarryCapacity = 5;
    public const int FoodTargetPerColonist = 3;

    // Budgets / AI throttling
    /// <summary>Max nodes one "find nearest resource" search may expand (~45 tiles radius on open ground).</summary>
    public const int SearchMaxNodes = 6000;
    /// <summary>Total search nodes all thinking colonists may expand per tick. Caps the cost of AI regardless of population.</summary>
    public const int SearchNodesPerTick = 40000;
    public const int IdleCooldownTicks = 60;
    /// <summary>After a failed resource search, skip that search from the same chunk for this long.</summary>
    public const int ExhaustedSearchMemoTicks = TicksPerSecond * 20;
    public const int FailedPathCooldownTicks = 90;

    // Starting stock
    public const int StartWood = 40;
    public const int StartFood = 60;
}
