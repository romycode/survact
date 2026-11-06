using Survact.Sim.Data;
using Survact.Sim.World;

namespace Survact.Sim.Buildings;

/// <summary>Why a building can't go somewhere. The UI maps these to translated messages.</summary>
public enum PlacementError : byte
{
    None = 0,
    UnknownType,
    OutOfBounds,
    NotClearGround,     // trees, bushes, rock or water in the footprint
    NotFlat,            // footprint spans more than one terrain level
    Occupied,           // another building
    TooCloseToHeater,
    EntranceBlocked,    // the tile in front must be walkable and reachable from the footprint
    Unreachable,        // colonists can't walk from the stockpile to the entrance
    BlocksEntrance,     // would cover another building's entrance
}

/// <summary>
/// Authoritative placement rules. The client calls <see cref="Check"/> every frame for the preview;
/// the command processor calls it again when the command is applied (the sim never trusts input).
/// </summary>
public static class BuildRules
{
    /// <summary>Footprint must stay this far (Chebyshev, tiles) from the heater/stockpile tile.</summary>
    public const int HeaterClearance = 1;

    public static PlacementError Check(Simulation sim, int type, int x, int y)
    {
        var table = sim.Data.Buildings;
        if ((uint)type >= (uint)table.Count) return PlacementError.UnknownType;
        var t = table[type];
        var map = sim.Map;

        if (!map.InBounds(x, y) || !map.InBounds(x + t.Width - 1, y + t.Height - 1)) return PlacementError.OutOfBounds;

        int level = map.LevelAt(x, y);
        var colony = sim.Colony;
        for (int ty = y; ty < y + t.Height; ty++)
        for (int tx = x; tx < x + t.Width; tx++)
        {
            int i = map.Index(tx, ty);
            if (map.BuildingAt(i) >= 0) return PlacementError.Occupied;
            if (map.Get(i) is not (Tile.Grass or Tile.Snow)) return PlacementError.NotClearGround;
            if (map.LevelAt(i) != level) return PlacementError.NotFlat;
            if (Math.Max(Math.Abs(tx - colony.StockX), Math.Abs(ty - colony.StockY)) <= HeaterClearance)
                return PlacementError.TooCloseToHeater;
        }

        var store = sim.Buildings;
        for (int id = 0; id < store.Count; id++)
        {
            ref var other = ref store[id];
            if (other.Stage == BuildingStage.Removed) continue;
            var (ox, oy) = BuildingStore.EntranceOf(other, table[other.Type]);
            if (ox >= x && ox < x + t.Width && oy >= y && oy < y + t.Height) return PlacementError.BlocksEntrance;
        }

        int ex = x + t.Width / 2, ey = y + t.Height;
        if (!map.InBounds(ex, ey)) return PlacementError.EntranceBlocked;
        int entrance = map.Index(ex, ey);
        if (map.BuildingAt(entrance) >= 0 || !map.Rules.Walkable(map.Get(entrance))
            || Math.Abs(map.LevelAt(entrance) - level) > 1)
            return PlacementError.EntranceBlocked;

        if (!sim.Regions.Connected(map.Index(colony.StockX, colony.StockY), entrance)) return PlacementError.Unreachable;
        return PlacementError.None;
    }
}
