namespace Survact.Sim.World;

public enum Tile : byte
{
    Grass,
    Water,
    Rock,
    Tree,
    Bush,
    Snow,
}

public static class TileRules
{
    /// <summary>A* cost of entering a tile. 0 = impassable.</summary>
    public static int MoveCost(Tile t) => t switch
    {
        Tile.Grass => 10,
        Tile.Snow => 14,
        Tile.Bush => 14,
        Tile.Tree => 20,
        _ => 0,
    };

    public static bool Walkable(Tile t) => MoveCost(t) > 0;

    /// <summary>Units a fresh tile holds when generated.</summary>
    public static ushort InitialAmount(Tile t) => t switch
    {
        Tile.Tree => 30,
        Tile.Bush => 20,
        _ => 0,
    };

    /// <summary>What the tile turns into once depleted.</summary>
    public static Tile Depleted(Tile t) => t switch
    {
        Tile.Tree => Tile.Grass,
        Tile.Bush => Tile.Grass,
        _ => t,
    };
}
