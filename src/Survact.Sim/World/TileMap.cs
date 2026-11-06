namespace Survact.Sim.World;

/// <summary>
/// Tile data stored as flat arrays (cache friendly for pathfinding and systems).
/// Chunks exist as the unit of change tracking: the renderer only rebuilds chunks
/// whose version changed, and later the sim can use them for LOD / sleeping regions.
/// </summary>
public sealed class TileMap
{
    public const int ChunkSize = 32;

    /// <summary>Terrain is terraced: each tile sits on an integer level in [0, MaxLevel].</summary>
    public const int MaxLevel = 10;

    public readonly int Width;
    public readonly int Height;
    public readonly int ChunksX;
    public readonly int ChunksY;

    internal readonly Tile[] Tiles;
    internal readonly ushort[] Amount;
    internal readonly bool[] Reserved;
    internal readonly byte[] Levels;

    /// <summary>Building id + 1 occupying each tile (0 = free). Derived from Buildings; not saved.</summary>
    internal readonly int[] Occupant;

    /// <summary>Incremented whenever any tile in the chunk changes. Read by renderers.</summary>
    public readonly int[] ChunkVersion;

    /// <summary>Incremented when any tile changes between walkable and blocked. Invalidates regions / path caches.</summary>
    public int WalkabilityVersion { get; private set; }

    public TileTable Rules { get; }

    public TileMap(int width, int height, TileTable rules)
    {
        Rules = rules;
        if (width % ChunkSize != 0 || height % ChunkSize != 0)
            throw new ArgumentException($"Map size must be a multiple of {ChunkSize}.");

        Width = width;
        Height = height;
        ChunksX = width / ChunkSize;
        ChunksY = height / ChunkSize;
        Tiles = new Tile[width * height];
        Amount = new ushort[width * height];
        Reserved = new bool[width * height];
        Levels = new byte[width * height];
        Occupant = new int[width * height];
        ChunkVersion = new int[ChunksX * ChunksY];
    }

    public int Count => Tiles.Length;

    public int Index(int x, int y) => y * Width + x;
    public int X(int index) => index % Width;
    public int Y(int index) => index / Width;
    public bool InBounds(int x, int y) => (uint)x < (uint)Width && (uint)y < (uint)Height;

    public Tile Get(int index) => Tiles[index];
    public Tile Get(int x, int y) => Tiles[Index(x, y)];
    public ushort AmountAt(int index) => Amount[index];
    public bool IsReserved(int index) => Reserved[index];
    public ReadOnlySpan<Tile> AllTiles => Tiles;
    public int LevelAt(int index) => Levels[index];
    public int LevelAt(int x, int y) => Levels[Index(x, y)];

    public void SetLevel(int index, int level)
    {
        byte l = (byte)Math.Clamp(level, 0, MaxLevel);
        if (Levels[index] == l) return;
        Levels[index] = l;
        WalkabilityVersion++; // edges to neighbours may have become (or stopped being) cliffs
        TouchChunk(index);
    }

    /// <summary>Building id on this tile, or -1.</summary>
    public int BuildingAt(int index) => Occupant[index] - 1;

    internal void SetOccupant(int index, int buildingId)
    {
        int value = buildingId + 1;
        if (Occupant[index] == value) return;
        Occupant[index] = value;
        WalkabilityVersion++;
    }

    /// <summary>
    /// Can a walker move from one tile to a 4-adjacent one? The target must be walkable terrain, free
    /// of buildings, and at most one level up or down (two or more is a cliff).
    /// Buildings only block ENTERING: a colonist caught on a tile when a building is placed can still
    /// walk off it, and no path ever goes through one.
    /// </summary>
    public bool CanStep(int from, int to) =>
        Occupant[to] == 0 && Rules.Walkable(Tiles[to]) && Rules.Walkable(Tiles[from])
        && Math.Abs(Levels[to] - Levels[from]) <= 1;

    /// <summary>Cost of a step (only meaningful when CanStep): terrain cost plus climbing up or down.</summary>
    public int StepCost(int from, int to)
    {
        int cost = Rules.MoveCost(Tiles[to]);
        int climb = Levels[to] - Levels[from];
        return climb > 0 ? cost + Rules.ClimbUpCost : climb < 0 ? cost + Rules.ClimbDownCost : cost;
    }

    public void Set(int index, Tile tile, ushort amount)
    {
        if (Rules.Walkable(Tiles[index]) != Rules.Walkable(tile)) WalkabilityVersion++;
        Tiles[index] = tile;
        Amount[index] = amount;
        TouchChunk(index);
    }

    public void Reserve(int index) => Reserved[index] = true;
    public void Release(int index) => Reserved[index] = false;

    /// <summary>Removes up to <paramref name="max"/> units. Depletes the tile when empty.</summary>
    public int Take(int index, int max)
    {
        int taken = Math.Min(max, Amount[index]);
        Amount[index] -= (ushort)taken;
        if (Amount[index] == 0)
        {
            Set(index, Rules.Depleted(Tiles[index]), 0);
        }
        return taken;
    }

    private void TouchChunk(int index)
    {
        int cx = X(index) / ChunkSize;
        int cy = Y(index) / ChunkSize;
        ChunkVersion[cy * ChunksX + cx]++;
    }
}
