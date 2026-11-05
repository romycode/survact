using System.Numerics;
using Survact.Sim.World;

namespace Survact.Game.World.Geometry;

/// <summary>
/// Builds one terrain chunk: a flat-topped block per tile at a height that depends on its type,
/// plus vertical side faces wherever a neighbour is lower (lake banks, snow ledges, rock cliffs).
/// Blocky on purpose: the low-poly diorama look, and the tile grid stays readable for building.
/// Trees and bushes are NOT part of the terrain: they are instanced (see Scatter).
/// </summary>
public static class TerrainMesher
{
    public const float WaterHeight = -0.22f;
    private const float Bottom = -1.5f;

    public static float HeightOf(Tile tile, int x, int y) => tile switch
    {
        Tile.Water => WaterHeight,
        Tile.Snow => 0.28f,
        Tile.Rock => 0.62f + Noise(x, y, 3) * 0.28f,
        _ => 0f,
    };

    public static MeshData BuildChunk(TileMap map, int chunk)
    {
        const int size = TileMap.ChunkSize;
        int ox = chunk % map.ChunksX * size, oy = chunk / map.ChunksX * size;
        var m = new MeshData();

        for (int y = oy; y < oy + size; y++)
        for (int x = ox; x < ox + size; x++)
        {
            var tile = map.Get(x, y);
            float h = HeightOf(tile, x, y);
            var top = TopColor(tile, x, y);

            m.Quad(new Vector3(x, h, y), new Vector3(x + 1, h, y), new Vector3(x + 1, h, y + 1), new Vector3(x, h, y + 1),
                   Vector3.UnitY, top);

            var side = new Vector4(top.X * 0.72f, top.Y * 0.70f, top.Z * 0.70f, SurfaceKind.Plain);
            if (tile == Tile.Water) side = SurfaceKind.Rgb(0.30f, 0.24f, 0.18f, SurfaceKind.Plain);
            Side(m, map, x, y, x, y - 1, h, side, new Vector3(x, 0, y), new Vector3(x + 1, 0, y), -Vector3.UnitZ);
            Side(m, map, x, y, x, y + 1, h, side, new Vector3(x, 0, y + 1), new Vector3(x + 1, 0, y + 1), Vector3.UnitZ);
            Side(m, map, x, y, x - 1, y, h, side, new Vector3(x, 0, y), new Vector3(x, 0, y + 1), -Vector3.UnitX);
            Side(m, map, x, y, x + 1, y, h, side, new Vector3(x + 1, 0, y), new Vector3(x + 1, 0, y + 1), Vector3.UnitX);
        }
        return m;
    }

    private static void Side(MeshData m, TileMap map, int x, int y, int nx, int ny, float h, Vector4 color,
                             Vector3 a, Vector3 b, Vector3 outward)
    {
        float nh = map.InBounds(nx, ny) ? HeightOf(map.Get(nx, ny), nx, ny) : Bottom;
        if (nh >= h) return;
        a.Y = b.Y = h;
        var a2 = a with { Y = nh };
        var b2 = b with { Y = nh };
        // Banks of a lake get earth colour; ledges keep the darkened top colour.
        m.Quad(a, b, b2, a2, outward, color);
    }

    private static Vector4 TopColor(Tile tile, int x, int y)
    {
        float shade = 0.93f + Noise(x, y, 0) * 0.14f;
        Vector3 c = tile switch
        {
            Tile.Grass => new(0.30f, 0.43f, 0.24f),
            Tile.Tree => new(0.23f, 0.34f, 0.19f),   // forest floor under the pine
            Tile.Bush => new(0.32f, 0.42f, 0.23f),
            Tile.Water => new(0.17f, 0.30f, 0.45f),
            Tile.Rock => new(0.40f, 0.40f, 0.44f),
            Tile.Snow => new(0.84f, 0.87f, 0.92f),
            _ => new(1f, 0f, 1f),
        };
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
            float h = TerrainMesher.HeightOf(wanted, x, y);
            output.Add(new Instance(new Vector3(x + 0.5f + jx, h, y + 0.5f + jz), yaw, scale));
        }
    }
}
