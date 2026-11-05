namespace Survact.Sim.Data;

/// <summary>
/// Baked balance: everything converted to per-tick units once at load so systems do no unit math.
/// Read-only at runtime. Systems read it through Simulation.Balance.
/// </summary>
public sealed class Balance
{
    // Time
    public int TicksPerDay { get; private init; }

    // Climate
    public float StartTemperature { get; private init; }
    public float TemperatureDropPerDay { get; private init; }
    public float DailySwing { get; private init; }
    public float MinTemperature { get; private init; }
    public float ComfortTemperature { get; private init; }

    // Needs
    public float HungerPerTick { get; private init; }
    public float ColdLossPerDegreeTick { get; private init; }
    public float HeaterWarmthPerTick { get; private init; }
    public float AmbientRecoveryPerTick { get; private init; }
    public float EatThreshold { get; private init; }
    public float WarmThreshold { get; private init; }
    public float WarmEnough { get; private init; }

    // Heater
    public int HeatRadius { get; private init; }
    public float HeaterBurnPerDegreeTick { get; private init; }

    // Work
    public float MoveSpeedTilesPerTick { get; private init; }
    public int GatherTicks { get; private init; }
    public int EatTicks { get; private init; }
    public int CarryCapacity { get; private init; }
    public int FoodTargetPerColonist { get; private init; }

    // AI budgets
    public int SearchMaxNodes { get; private init; }
    public int SearchNodesPerTick { get; private init; }
    public int IdleCooldownTicks { get; private init; }
    public int FailedPathCooldownTicks { get; private init; }
    public int ExhaustedSearchMemoTicks { get; private init; }

    // Start
    public int StartWood { get; private init; }
    public int StartFood { get; private init; }

    internal static Balance Bake(GameDataDto d, List<string> errors)
    {
        const int tps = Simulation.TicksPerSecond;
        int ticksPerDay = Seconds(d.DayLengthSeconds);

        Positive(d.DayLengthSeconds, "day_length_seconds");
        Positive(d.Needs.HungerDaysToEmpty, "needs.hunger_days_to_empty");
        Fraction(d.Needs.EatBelow, "needs.eat_below");
        Fraction(d.Needs.WarmBelow, "needs.warm_below");
        Fraction(d.Needs.WarmEnough, "needs.warm_enough");
        NonNegative(d.Needs.ColdLossPerDegreePerDay, "needs.cold_loss_per_degree_per_day");
        Positive(d.Work.MoveSpeedTilesPerSecond, "work.move_speed_tiles_per_second");
        Positive(d.Work.CarryCapacity, "work.carry_capacity");
        Positive(d.Heater.RadiusTiles, "heater.radius_tiles");
        Positive(d.Ai.SearchMaxNodes, "ai.search_max_nodes");
        Positive(d.Ai.SearchNodesPerTick, "ai.search_nodes_per_tick");
        if (d.Climate.MinTemperature > d.Climate.StartTemperature)
            errors.Add("climate.min_temperature must be <= climate.start_temperature");
        if (d.Needs.WarmEnough <= d.Needs.WarmBelow)
            errors.Add("needs.warm_enough must be > needs.warm_below (colonists would never stop warming)");

        return new Balance
        {
            TicksPerDay = Math.Max(1, ticksPerDay),

            StartTemperature = d.Climate.StartTemperature,
            TemperatureDropPerDay = d.Climate.DropPerDay,
            DailySwing = d.Climate.DailySwing,
            MinTemperature = d.Climate.MinTemperature,
            ComfortTemperature = d.Climate.ComfortTemperature,

            HungerPerTick = 1f / (d.Needs.HungerDaysToEmpty * Math.Max(1, ticksPerDay)),
            ColdLossPerDegreeTick = d.Needs.ColdLossPerDegreePerDay / Math.Max(1, ticksPerDay),
            HeaterWarmthPerTick = d.Needs.HeaterWarmthPerSecond / tps,
            AmbientRecoveryPerTick = d.Needs.AmbientRecoveryPerSecond / tps,
            EatThreshold = d.Needs.EatBelow,
            WarmThreshold = d.Needs.WarmBelow,
            WarmEnough = d.Needs.WarmEnough,

            HeatRadius = d.Heater.RadiusTiles,
            HeaterBurnPerDegreeTick = d.Heater.WoodPerDegreePerDay / Math.Max(1, ticksPerDay),

            MoveSpeedTilesPerTick = d.Work.MoveSpeedTilesPerSecond / tps,
            GatherTicks = Seconds(d.Work.GatherSeconds),
            EatTicks = Seconds(d.Work.EatSeconds),
            CarryCapacity = d.Work.CarryCapacity,
            FoodTargetPerColonist = d.Work.FoodTargetPerColonist,

            SearchMaxNodes = d.Ai.SearchMaxNodes,
            SearchNodesPerTick = d.Ai.SearchNodesPerTick,
            IdleCooldownTicks = Seconds(d.Ai.IdleCooldownSeconds),
            FailedPathCooldownTicks = Seconds(d.Ai.FailedPathCooldownSeconds),
            ExhaustedSearchMemoTicks = Seconds(d.Ai.ExhaustedSearchMemoSeconds),

            StartWood = d.Start.Wood,
            StartFood = d.Start.Food,
        };

        static int Seconds(float s) => (int)MathF.Round(s * tps);
        void Positive(float v, string name) { if (!(v > 0)) errors.Add($"{name} must be > 0 (got {v})"); }
        void NonNegative(float v, string name) { if (!(v >= 0)) errors.Add($"{name} must be >= 0 (got {v})"); }
        void Fraction(float v, string name) { if (v is < 0 or > 1) errors.Add($"{name} must be in [0, 1] (got {v})"); }
    }
}
