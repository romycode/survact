using System.Numerics;
using Survact.Sim.World;

namespace Survact.Game.World.Geometry;

/// <summary>
/// Builds one terrain chunk from the sim's terrace levels with RAMPS and CLIFFS:
///  - Every tile corner takes the average height of the tiles sharing it, but only of tiles at most
///    one level away. So walkable one-level steps become smooth slopes, seamlessly (neighbours
///    compute the same corner from the same tiles), while 2+ level drops keep vertical rock walls.
///    What looks passable is passable; what looks like a wall is a cliff in the sim.
///  - Water stays flat and sits below its banks.
/// Trees, bushes and boulders are NOT part of the terrain: they are instanced (see Scatter).
/// </summary>
public static class TerrainMesher
{
    /// <summary>World units per terrain level.</summary>
    public const float LevelHeight = 1.0f;
    public const float WaterDepth = 0.22f;
    private const float Bottom = -1.5f;

    /// <summary>Flat reference height of a tile (its level), before smoothing into ramps.</summary>
    private static float BaseHeight(TileMap map, int x, int y)
    {
        float h = map.LevelAt(x, y) * LevelHeight;
        return map.Get(x, y) == Tile.Water ? h - WaterDepth : h;
    }

    /// <summary>Do two tiles blend into one surface at their shared corners (ramp) or not (wall/bank)?</summary>
    private static bool Blends(TileMap map, int ax, int ay, int bx, int by)
    {
        bool aWater = map.Get(ax, ay) == Tile.Water, bWater = map.Get(bx, by) == Tile.Water;
        if (aWater != bWater) return false;
        return Math.Abs(map.LevelAt(ax, ay) - map.LevelAt(bx, by)) <= 1;
    }

    /// <summary>Height of grid point (gx, gy) as seen from tile (tx, ty), one of the four tiles touching it.</summary>
    public static float CornerHeight(TileMap map, int tx, int ty, int gx, int gy)
    {
        float sum = 0;
        int count = 0;
        for (int ny = gy - 1; ny <= gy; ny++)
        for (int nx = gx - 1; nx <= gx; nx++)
        {
            if (!map.InBounds(nx, ny) || !Blends(map, tx, ty, nx, ny)) continue;
            sum += BaseHeight(map, nx, ny);
            count++;
        }
        return count > 0 ? sum / count : BaseHeight(map, tx, ty);
    }

    /// <summary>
    /// Surface height at any world (x, z), bilinear over the tile's corners. Where colonists walk,
    /// props stand and the camera picks.
    /// </summary>
    public static float SurfaceAt(TileMap map, float x, float z)
    {
        int tx = Math.Clamp((int)MathF.Floor(x), 0, map.Width - 1);
        int ty = Math.Clamp((int)MathF.Floor(z), 0, map.Height - 1);
        float fx = Math.Clamp(x - tx, 0f, 1f), fz = Math.Clamp(z - ty, 0f, 1f);
        float h00 = CornerHeight(map, tx, ty, tx, ty), h10 = CornerHeight(map, tx, ty, tx + 1, ty);
        float h01 = CornerHeight(map, tx, ty, tx, ty + 1), h11 = CornerHeight(map, tx, ty, tx + 1, ty + 1);
        float top = h00 + (h10 - h00) * fx, bottom = h01 + (h11 - h01) * fx;
        return top + (bottom - top) * fz;
    }

    public static MeshData BuildChunk(TileMap map, int chunk)
    {
        const int size = TileMap.ChunkSize;
        int ox = chunk % map.ChunksX * size, oy = chunk / map.ChunksX * size;
        var m = new MeshData();

        for (int y = oy; y < oy + size; y++)
        for (int x = ox; x < ox + size; x++)
        {
            var tile = map.Get(x, y);
            var top = TopColor(tile, map.LevelAt(x, y));
            if (tile != Tile.Water) top *= new Vector4(new Vector3(TileLight(map, x, y)), 1f);

            var c00 = new Vector3(x, CornerHeight(map, x, y, x, y), y);
            var c10 = new Vector3(x + 1, CornerHeight(map, x, y, x + 1, y), y);
            var c11 = new Vector3(x + 1, CornerHeight(map, x, y, x + 1, y + 1), y + 1);
            var c01 = new Vector3(x, CornerHeight(map, x, y, x, y + 1), y + 1);

            var t00 = tile == Tile.Water ? ShoreColor(map, x, y) : top;
            var t10 = tile == Tile.Water ? ShoreColor(map, x + 1, y) : top;
            var t11 = tile == Tile.Water ? ShoreColor(map, x + 1, y + 1) : top;
            var t01 = tile == Tile.Water ? ShoreColor(map, x, y + 1) : top;

            // Split the (possibly non-planar) top along the flatter diagonal: no folded creases.
            if (MathF.Abs(c00.Y - c11.Y) <= MathF.Abs(c10.Y - c01.Y))
            {
                m.Triangle(c00, c10, c11, t00, t10, t11, Vector3.UnitY);
                m.Triangle(c00, c11, c01, t00, t11, t01, Vector3.UnitY);
            }
            else
            {
                m.Triangle(c00, c10, c01, t00, t10, t01, Vector3.UnitY);
                m.Triangle(c10, c11, c01, t10, t11, t01, Vector3.UnitY);
            }

            var ledge = SurfaceKind.Rgb(0.27f, 0.22f, 0.17f, SurfaceKind.RockFace);
            var cliff = SurfaceKind.Rgb(0.28f, 0.30f, 0.33f, SurfaceKind.RockFace);

            Wall(m, map, x, y - 1, c00, c10, x, y, x + 1, y, -Vector3.UnitZ, ledge, cliff);
            Wall(m, map, x, y + 1, c01, c11, x, y + 1, x + 1, y + 1, Vector3.UnitZ, ledge, cliff);
            Wall(m, map, x - 1, y, c00, c01, x, y, x, y + 1, -Vector3.UnitX, ledge, cliff);
            Wall(m, map, x + 1, y, c10, c11, x + 1, y, x + 1, y + 1, Vector3.UnitX, ledge, cliff);
        }
        return m;
    }

    /// <summary>
    /// Vertical face between this tile's edge (a, b) and the neighbour's view of the same two corners.
    /// Where the two surfaces blend (ramp) the heights match and nothing is emitted.
    /// </summary>
    private static void Wall(MeshData m, TileMap map, int nx, int ny, Vector3 a, Vector3 b,
                             int agx, int agy, int bgx, int bgy, Vector3 outward, Vector4 ledge, Vector4 cliff)
    {
        float na, nb;
        if (map.InBounds(nx, ny))
        {
            na = CornerHeight(map, nx, ny, agx, agy);
            nb = CornerHeight(map, nx, ny, bgx, bgy);
        }
        else na = nb = Bottom;

        if (a.Y + b.Y <= na + nb + 1e-3f) return; // neighbour is level or higher: its own wall covers it
        float drop = MathF.Max(a.Y - na, b.Y - nb);
        var lowerA = a with { Y = MathF.Min(na, a.Y) };
        var lowerB = b with { Y = MathF.Min(nb, b.Y) };
        if (drop <= LevelHeight * 1.5f)
        {
            m.Quad(a, b, lowerB, lowerA, outward, ledge);
            return;
        }

        // Break the flat cliff face with a shallow faceted bulge. The four boundary vertices
        // stay put, so ramps, tile picking, chunk seams and traversability remain as before.
        float lean = Noise(agx + bgx, agy + bgy, 8);
        var upper = Vector3.Lerp(a, b, 0.30f + lean * 0.40f);
        var lower = Vector3.Lerp(lowerA, lowerB, 0.30f + lean * 0.40f);
        var split = Vector3.Lerp(lower, upper, 0.32f + lean * 0.30f) + outward * 0.16f;
        m.Triangle(a, b, split, cliff, outward);
        m.Triangle(b, lowerB, split, cliff, outward);
        m.Triangle(lowerB, lowerA, split, cliff, outward);
        m.Triangle(lowerA, a, split, cliff, outward);
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

    // All water tiles meeting at a corner agree on its tint, including across chunk boundaries.
    private static Vector4 ShoreColor(TileMap map, int x, int y)
    {
        int water = 0;
        for (int ny = y - 1; ny <= y; ny++)
        for (int nx = x - 1; nx <= x; nx++)
            if (map.InBounds(nx, ny) && map.Get(nx, ny) == Tile.Water) water++;

        float depth = (water - 1) / 3f;
        var shallow = new Vector3(0.22f, 0.39f, 0.33f);
        var deep = new Vector3(0.065f, 0.21f, 0.245f);
        return new Vector4(Vector3.Lerp(shallow, deep, depth), SurfaceKind.Water);
    }

    private static Vector4 TopColor(Tile tile, int level)
    {
        Vector3 c = tile switch
        {
            Tile.Grass or Tile.Tree or Tile.Bush => new(0.29f, 0.35f, 0.23f),
            Tile.Water => new(0.17f, 0.30f, 0.45f),
            Tile.Rock => new(0.36f, 0.35f, 0.33f),   // stony ground under the boulder
            Tile.Snow => new(0.86f, 0.89f, 0.94f),   // permanent snow caps
            _ => new(1f, 0f, 1f),
        };
        // Vegetation thins with altitude: grassy tops fade toward alpine brown-grey on the way up.
        if (tile is Tile.Grass or Tile.Bush or Tile.Tree or Tile.Rock)
            c = Vector3.Lerp(c, Alpine, Math.Clamp((level - 2) / 6f, 0f, 0.85f));
        float kind = tile == Tile.Water ? SurfaceKind.Water : SurfaceKind.Ground;
        return new Vector4(c, kind);
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

/// <summary>Deterministic placement of instanced props (trees, bushes, boulders) for one chunk.</summary>
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
            float px = x + 0.5f + jx, pz = y + 0.5f + jz;
            output.Add(new Instance(new Vector3(px, TerrainMesher.SurfaceAt(map, px, pz) - 0.03f, pz), yaw, scale));
        }
    }
}
