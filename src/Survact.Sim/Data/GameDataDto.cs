namespace Survact.Sim.Data;

// Authoring format: mirrors game/data/*.json one to one, in human units.
// Designers edit JSON; nothing here is read by systems directly — see Balance for the baked form.

public sealed class GameDataDto
{
    public required float DayLengthSeconds { get; init; }
    public required ClimateDto Climate { get; init; }
    public required NeedsDto Needs { get; init; }
    public required HeaterDto Heater { get; init; }
    public required WorkDto Work { get; init; }
    public required AiDto Ai { get; init; }
    public required StartDto Start { get; init; }
    public required TerrainDto Terrain { get; init; }
    public required Dictionary<string, TileDto> Tiles { get; init; }
}

public sealed class ClimateDto
{
    public required float StartTemperature { get; init; }
    public required float DropPerDay { get; init; }
    public required float DailySwing { get; init; }
    public required float MinTemperature { get; init; }
    public required float ComfortTemperature { get; init; }
}

public sealed class NeedsDto
{
    public required float HungerDaysToEmpty { get; init; }
    public required float EatBelow { get; init; }
    public required float WarmBelow { get; init; }
    public required float WarmEnough { get; init; }
    public required float ColdLossPerDegreePerDay { get; init; }
    public required float HeaterWarmthPerSecond { get; init; }
    public required float AmbientRecoveryPerSecond { get; init; }
}

public sealed class HeaterDto
{
    public required int RadiusTiles { get; init; }
    public required float WoodPerDegreePerDay { get; init; }
}

public sealed class WorkDto
{
    public required float MoveSpeedTilesPerSecond { get; init; }
    public required float GatherSeconds { get; init; }
    public required float EatSeconds { get; init; }
    public required int CarryCapacity { get; init; }
    public required int FoodTargetPerColonist { get; init; }
}

public sealed class AiDto
{
    public required int SearchMaxNodes { get; init; }
    public required int SearchNodesPerTick { get; init; }
    public required float IdleCooldownSeconds { get; init; }
    public required float FailedPathCooldownSeconds { get; init; }
    public required float ExhaustedSearchMemoSeconds { get; init; }
}

public sealed class StartDto
{
    public required int Wood { get; init; }
    public required int Food { get; init; }
}

public sealed class TileDto
{
    public required int MoveCost { get; init; }
    public int Amount { get; init; }
    public string? DepletesTo { get; init; }
}

public sealed class TerrainDto
{
    public required int ClimbUpCost { get; init; }
    public required int ClimbDownCost { get; init; }
    public required float LapseRatePerLevel { get; init; }
}
