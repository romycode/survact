using Survact.Sim.Data;

namespace Survact.Sim.World;

/// <summary>
/// Per-tile-type properties, baked from data into flat arrays indexed by <see cref="Tile"/>.
/// The enum is the identity (save format, worldgen); the numbers live in data.
/// </summary>
public sealed class TileTable
{
    private readonly int[] _moveCost;
    private readonly ushort[] _amount;
    private readonly Tile[] _depletesTo;

    private TileTable(int[] moveCost, ushort[] amount, Tile[] depletesTo, int climbUp, int climbDown)
    {
        _moveCost = moveCost;
        _amount = amount;
        _depletesTo = depletesTo;
        ClimbUpCost = climbUp;
        ClimbDownCost = climbDown;
    }

    /// <summary>Extra path cost for stepping one level up / down (terrain.climb_*_cost).</summary>
    public int ClimbUpCost { get; }
    public int ClimbDownCost { get; }

    /// <summary>A* cost of entering a tile. 0 = impassable.</summary>
    public int MoveCost(Tile t) => _moveCost[(int)t];
    public bool Walkable(Tile t) => _moveCost[(int)t] > 0;
    public ushort InitialAmount(Tile t) => _amount[(int)t];
    public Tile Depleted(Tile t) => _depletesTo[(int)t];

    internal static TileTable Bake(Dictionary<string, TileDto> dtos, TerrainDto terrain, List<string> errors)
    {
        if (terrain.ClimbUpCost < 0) errors.Add("terrain.climb_up_cost must be >= 0");
        if (terrain.ClimbDownCost < 0) errors.Add("terrain.climb_down_cost must be >= 0");

        var tiles = Enum.GetValues<Tile>();
        var moveCost = new int[tiles.Length];
        var amount = new ushort[tiles.Length];
        var depletes = new Tile[tiles.Length];

        foreach (var key in dtos.Keys)
            if (!Enum.TryParse<Tile>(key, ignoreCase: true, out _))
                errors.Add($"tiles.{key}: unknown tile type (known: {string.Join(", ", tiles).ToLowerInvariant()})");

        foreach (var tile in tiles)
        {
            string name = tile.ToString().ToLowerInvariant();
            if (!dtos.TryGetValue(name, out var dto))
            {
                errors.Add($"tiles.{name}: missing");
                continue;
            }

            if (dto.MoveCost < 0) errors.Add($"tiles.{name}.move_cost must be >= 0");
            if (dto.Amount is < 0 or > ushort.MaxValue) errors.Add($"tiles.{name}.amount out of range");

            moveCost[(int)tile] = dto.MoveCost;
            amount[(int)tile] = (ushort)Math.Clamp(dto.Amount, 0, ushort.MaxValue);
            depletes[(int)tile] = tile;

            if (dto.DepletesTo is { } target)
            {
                if (Enum.TryParse<Tile>(target, ignoreCase: true, out var t)) depletes[(int)tile] = t;
                else errors.Add($"tiles.{name}.depletes_to: unknown tile '{target}'");
            }
        }

        return new TileTable(moveCost, amount, depletes, terrain.ClimbUpCost, terrain.ClimbDownCost);
    }
}
