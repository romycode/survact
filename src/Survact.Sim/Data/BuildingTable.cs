namespace Survact.Sim.Data;

/// <summary>A building type, baked from data (game/data/balance.json → "buildings").</summary>
public sealed record BuildingType(
    int Index,
    string Name,
    int Width,
    int Height,
    int WoodCost,
    int BuildTicks,
    int MaxBuilders,
    int ShelterCapacity,
    float Insulation)
{
    public bool IsShelter => ShelterCapacity > 0;
}

/// <summary>
/// All building types, indexed by a stable-for-this-data index (names sorted ordinally).
/// Commands and the replay log use the index (same data → same index); saves store the NAME so a
/// save survives types being added to the data.
/// </summary>
public sealed class BuildingTable
{
    public const int MaxSize = 4;
    private static readonly HashSet<string> KnownResources = ["wood"];

    private readonly BuildingType[] _types;
    private readonly Dictionary<string, int> _byName;

    private BuildingTable(BuildingType[] types)
    {
        _types = types;
        _byName = types.ToDictionary(t => t.Name, t => t.Index, StringComparer.Ordinal);
    }

    public int Count => _types.Length;
    public BuildingType this[int index] => _types[index];
    public IReadOnlyList<BuildingType> All => _types;

    public int IndexOf(string name) => _byName.TryGetValue(name, out int i) ? i : -1;

    internal static BuildingTable Bake(Dictionary<string, BuildingDto> dtos, List<string> errors)
    {
        var types = new List<BuildingType>();
        foreach (var (name, d) in dtos.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            string at = $"buildings.{name}";
            if (d.Size is not { Length: 2 } || d.Size[0] is < 1 or > MaxSize || d.Size[1] is < 1 or > MaxSize)
                errors.Add($"{at}.size must be [w, h] with each in 1..{MaxSize}");
            foreach (var res in d.Cost.Keys.Where(k => !KnownResources.Contains(k)))
                errors.Add($"{at}.cost.{res}: unknown resource (known: {string.Join(", ", KnownResources)})");
            int wood = d.Cost.GetValueOrDefault("wood");
            if (wood < 0) errors.Add($"{at}.cost.wood must be >= 0");
            if (!(d.BuildSeconds > 0)) errors.Add($"{at}.build_seconds must be > 0");
            if (d.MaxBuilders < 1) errors.Add($"{at}.max_builders must be >= 1");
            if (d.Shelter is { } sh && sh.Capacity < 1) errors.Add($"{at}.shelter.capacity must be >= 1");

            int w = d.Size is { Length: 2 } ? Math.Clamp(d.Size[0], 1, MaxSize) : 1;
            int h = d.Size is { Length: 2 } ? Math.Clamp(d.Size[1], 1, MaxSize) : 1;
            types.Add(new BuildingType(
                types.Count, name, w, h, Math.Max(0, wood),
                Math.Max(1, (int)MathF.Round(d.BuildSeconds * Simulation.TicksPerSecond)),
                Math.Max(1, d.MaxBuilders),
                d.Shelter?.Capacity ?? 0,
                d.Shelter?.Insulation ?? 0f));
        }
        return new BuildingTable([.. types]);
    }
}
