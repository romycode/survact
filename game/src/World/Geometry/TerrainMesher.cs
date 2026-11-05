using System.Numerics;
using Survact.Sim.World;

namespace Survact.Game.World.Geometry;

/// <summary>
/// Builds one terrain chunk: a flat-topped block per tile at its terrace level (plus a small
/// offset by type: lakes sit below the bank, rock outcrops stick up), and vertical side faces
/// wherever a neighbour is lower. One-level drops read as ledges; 2+ levels (the sim's cliffs)
/// get bare rock walls, so what blocks movement is also what looks impassable.
/// Blocky on purpose: the low-poly diorama look, and the tile grid stays readable for building.
/// Trees and bushes are NOT part of the terrain: they are instanced (see Scatter).
/// </summary>
public static class TerrainMesher
{
    /// <summary>World units per terrain level.</summary>
    public const float LevelHeight = 1.0f;
    public const float WaterDepth = 0.22f;
    private const float Bottom = -1.5f;

    /// <summary>Top surface height of a tile in world units.</summary>
    public static float HeightAt(TileMap map, int x, int y)
    {
        float h = map.LevelAt(x, y) * LevelHeight;
        return map.Get(x, y) switch
        {
            Tile.Water => h - WaterDepth,
            Tile.Rock => h + 0.25f + Noise(x, y, 3) * 0.25f,
            _ => h,
        };
    }

    /// <summary>Walking surface: where colonists and props stand (same as HeightAt for walkable tiles).</summary>
    public static float GroundAt(TileMap map, int x, int y) => map.LevelAt(x, y) * LevelHeight;

    public static MeshData BuildChunk(TileMap map, int chunk)
    {
        const int size = TileMap.ChunkSize;
        int ox = chunk % map.ChunksX * size, oy = chunk / map.ChunksX * size;
        var m = new MeshData();

        for (int y = oy; y < oy + size; y++)
        for (int x = ox; x < ox + size; x++)
        {
            var tile = map.Get(x, y);
            float h = HeightAt(map, x, y);
            var top = TopColor(tile, x, y, map.LevelAt(x, y));
            if (tile != Tile.Water) top *= new Vector4(new Vector3(TileLight(map, x, y)), 1f);

            m.Quad(new Vector3(x, h, y), new Vector3(x + 1, h, y), new Vector3(x + 1, h, y + 1), new Vector3(x, h, y + 1),
                   Vector3.UnitY, top);

            var ledge = new Vector4(top.X * 0.72f, top.Y * 0.70f, top.Z * 0.70f, SurfaceKind.Plain);
            if (tile == Tile.Water) ledge = SurfaceKind.Rgb(0.30f, 0.24f, 0.18f, SurfaceKind.Plain);
            float shade = 0.9f + Noise(x, y, 5) * 0.2f;
            var cliff = SurfaceKind.Rgb(0.40f * shade, 0.37f * shade, 0.34f * shade, SurfaceKind.Plain);
            Side(m, map, x, y - 1, h, ledge, cliff, new Vector3(x, 0, y), new Vector3(x + 1, 0, y), -Vector3.UnitZ);
            Side(m, map, x, y + 1, h, ledge, cliff, new Vector3(x, 0, y + 1), new Vector3(x + 1, 0, y + 1), Vector3.UnitZ);
            Side(m, map, x - 1, y, h, ledge, cliff, new Vector3(x, 0, y), new Vector3(x, 0, y + 1), -Vector3.UnitX);
            Side(m, map, x + 1, y, h, ledge, cliff, new Vector3(x + 1, 0, y), new Vector3(x + 1, 0, y + 1), Vector3.UnitX);
        }
        return m;
    }

    private static void Side(MeshData m, TileMap map, int nx, int ny, float h, Vector4 ledge, Vector4 cliff,
                             Vector3 a, Vector3 b, Vector3 outward)
    {
        float nh = map.InBounds(nx, ny) ? HeightAt(map, nx, ny) : Bottom;
        if (nh >= h) return;
        a.Y = b.Y = h;
        var a2 = a with { Y = nh };
        var b2 = b with { Y = nh };
        // Tall drops (cliffs, rock outcrops, map edge) are bare rock; small ones keep the ground colour.
        m.Quad(a, b, b2, a2, outward, h - nh > LevelHeight * 1.5f ? cliff : ledge);
    }

    /// <summary>
    /// Baked per-tile lighting so terraces read from above: darker at the foot of a wall (ambient
    /// occlusion from higher neighbours), a light lip on the edge of a drop, slightly brighter
    /// with altitude. Cheap (4 neighbour lookups) and stable: it's part of the chunk mesh.
    /// </summary>
    private static float TileLight(TileMap map, int x, int y)
    {
        int level = map.LevelAt(x, y);
        int higher = 0, lower = 0;
        foreach (var (nx, ny) in new[] { (x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1) })
        {
            if (!map.InBounds(nx, ny)) continue;
            int d = map.LevelAt(nx, ny) - level;
            if (d > 0) higher += Math.Min(d, 3);
            else if (d < 0) lower++;
        }
        float light = 1f - higher * 0.07f + Math.Min(lower, 2) * 0.05f;
        return light * (0.94f + level * 0.012f);
    }

    private static readonly Vector3 Alpine = new(0.47f, 0.44f, 0.37f); // thin turf and scree on high slopes

    private static Vector4 TopColor(Tile tile, int x, int y, int level)
    {
        float shade = 0.965f + Noise(x, y, 0) * 0.07f;
        Vector3 c = tile switch
        {
            Tile.Grass => new(0.30f, 0.43f, 0.24f),
            Tile.Tree => new(0.23f, 0.34f, 0.19f),   // forest floor under the pine
            Tile.Bush => new(0.32f, 0.42f, 0.23f),
            Tile.Water => new(0.17f, 0.30f, 0.45f),
            Tile.Rock => new(0.40f, 0.40f, 0.44f),
            Tile.Snow => new(0.86f, 0.89f, 0.94f),   // permanent snow caps
            _ => new(1f, 0f, 1f),
        };
        // Vegetation thins with altitude: grassy tops fade toward alpine brown-grey on the way up.
        if (tile is Tile.Grass or Tile.Bush or Tile.Tree)
            c = Vector3.Lerp(c, Alpine, Math.Clamp((level - 2) / 6f, 0f, 0.85f));
        float kind = tile == Tile.Water ? SurfaceKind.Water : SurfaceKind.Ground;
        return new Vector4(c * shade, kind);
    }

    internal static float Noise(int x, int y, int seed)
    {
        unchecked
        {
            uint h = (uint)x * 374761393u + (uint)y * 668265263u + (uint)seed * 2246822519u;
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xFFFF) / 65535f;
        }
    }
}

/// <summary>Deterministic placement of instanced props (trees, bushes) for one chunk.</summary>
public static class Scatter
{
    public readonly record struct Instance(Vector3 Position, float Yaw, float Scale);

    public static void Collect(TileMap map, int chunk, Tile wanted, List<Instance> output)
    {
        output.Clear();
        const int size = TileMap.ChunkSize;
        int ox = chunk % map.ChunksX * size, oy = chunk / map.ChunksX * size;

        for (int y = oy; y < oy + size; y++)
        for (int x = ox; x < ox + size; x++)
        {
            if (map.Get(x, y) != wanted) continue;
            float jx = (TerrainMesher.Noise(x, y, 11) - 0.5f) * 0.35f;
            float jz = (TerrainMesher.Noise(x, y, 12) - 0.5f) * 0.35f;
            float yaw = TerrainMesher.Noise(x, y, 13) * MathF.Tau;
            float scale = 0.85f + TerrainMesher.Noise(x, y, 14) * 0.4f;
            float h = TerrainMesher.GroundAt(map, x, y);
            output.Add(new Instance(new Vector3(x + 0.5f + jx, h, y + 0.5f + jz), yaw, scale));
        }
    }
}
