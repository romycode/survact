namespace Survact.Sim.World;

/// <summary>
/// Deterministic terrain from a seed. Noise fields:
///   lowland  — lakes on the plains;
///   range    — low-frequency mask deciding where mountain ranges are;
///   ridge    — sharp crests inside a range (|2n-1| inverted);
///   plateau  — mesas: plains raised 2–3 levels at once, so their edges are cliffs (escarpments);
///   ramp     — where a mesa edge breaks into a one-level ledge you can walk up;
///   moisture — forests and berry bushes.
/// Height is terraced into integer levels; above the treeline only grass, rock outcrops and,
/// at the top, permanent snow. Steps of 2+ levels between neighbours are cliffs.
/// </summary>
public static class WorldGen
{
    private const int TreelineLevel = 5;
    private const int BushLevel = 2;
    private const int SnowcapLevel = 9;
    private const float PlateauEdge = 0.63f;

    public static void Generate(TileMap map, uint seed)
    {
        // Pass 1: raw terrace levels from the noise fields.
        var raw = new byte[map.Count];
        for (int y = 0; y < map.Height; y++)
        for (int x = 0; x < map.Width; x++)
            raw[map.Index(x, y)] = (byte)RawLevel(x, y, seed);

        // Pass 2: 3x3 median removes one-tile spikes and pits, so terraces follow clean contour
        // lines instead of reading as noise. Cliffs and ramps survive (they're wider than a tile).
        var levels = Median3x3(raw, map.Width, map.Height);

        // Pass 3: tile types on the final relief.
        for (int y = 0; y < map.Height; y++)
        for (int x = 0; x < map.Width; x++)
        {
            int index = map.Index(x, y);
            int level = levels[index];
            float lowland = Fbm(x / 48f, y / 48f, seed, 4);
            float plateau = Fbm(x / 58f, y / 58f, seed ^ 0x27D4EB2Fu, 3);
            float moisture = Fbm(x / 28f, y / 28f, seed ^ 0x9E3779B9u, 3);
            float jitter = Hash(x, y, seed ^ 0x85EBCA6Bu);

            Tile tile;
            if (level == 0 && lowland < 0.30f && plateau <= PlateauEdge - 0.03f) tile = Tile.Water;
            else if (level >= SnowcapLevel) tile = Tile.Snow;
            else if (level >= 4 && jitter < 0.01f + level * 0.008f) tile = Tile.Rock;
            else if (level <= TreelineLevel && moisture > 0.58f && jitter < 0.6f) tile = Tile.Tree;
            else if (level <= BushLevel && moisture > 0.42f && jitter < 0.035f) tile = Tile.Bush;
            else tile = Tile.Grass;

            map.SetLevel(index, level);
            map.Set(index, tile, map.Rules.InitialAmount(tile));
        }
    }

    private static int RawLevel(int x, int y, uint seed)
    {
        float range = Fbm(x / 96f, y / 96f, seed ^ 0xA341316Cu, 4);
        float ridge = 1f - MathF.Abs(2f * Fbm(x / 34f, y / 34f, seed ^ 0xC8013EA4u, 2) - 1f);
        float mountain = SmoothStep(0.52f, 0.70f, range);
        // ridge² narrows the crests: peaks and spurs instead of broad flat summits.
        float height = mountain * (0.35f + 0.65f * ridge * ridge);
        int level = (int)(height * (TileMap.MaxLevel + 0.99f));

        // Mesas: a sharp threshold on the plateau field makes vertical escarpments; a thin band
        // just below it becomes a one-level ledge only where the ramp field allows: natural ramps.
        float plateau = Fbm(x / 58f, y / 58f, seed ^ 0x27D4EB2Fu, 3);
        float ramp = Fbm(x / 14f, y / 14f, seed ^ 0x165667B1u, 2);
        if (plateau > PlateauEdge) level += plateau > PlateauEdge + 0.07f ? 3 : 2;
        else if (plateau > PlateauEdge - 0.03f && ramp > 0.62f) level += 1;

        return Math.Clamp(level, 0, TileMap.MaxLevel);
    }

    private static byte[] Median3x3(byte[] src, int width, int height)
    {
        var dst = new byte[src.Length];
        Span<byte> window = stackalloc byte[9];
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
        {
            int n = 0;
            for (int dy = -1; dy <= 1; dy++)
            for (int dx = -1; dx <= 1; dx++)
            {
                int sx = Math.Clamp(x + dx, 0, width - 1), sy = Math.Clamp(y + dy, 0, height - 1);
                window[n++] = src[sy * width + sx];
            }
            window.Sort();
            dst[y * width + x] = window[4];
        }
        return dst;
    }

    /// <summary>Guarantees a usable, flat starting area around the stockpile.</summary>
    public static void ClearArea(TileMap map, int clearX, int clearY, int clearRadius)
    {
        int level = map.LevelAt(clearX, clearY);
        for (int y = clearY - clearRadius; y <= clearY + clearRadius; y++)
        for (int x = clearX - clearRadius; x <= clearX + clearRadius; x++)
        {
            if (!map.InBounds(x, y)) continue;
            int index = map.Index(x, y);
            map.SetLevel(index, level);
            map.Set(index, Tile.Grass, 0);
        }
    }

    private static float SmoothStep(float a, float b, float x)
    {
        float t = Math.Clamp((x - a) / (b - a), 0f, 1f);
        return t * t * (3f - 2f * t);
    }

    private static float Fbm(float x, float y, uint seed, int octaves)
    {
        float sum = 0, amp = 0.5f, norm = 0;
        for (int i = 0; i < octaves; i++)
        {
            sum += ValueNoise(x, y, seed + (uint)i * 1013u) * amp;
            norm += amp;
            x *= 2f;
            y *= 2f;
            amp *= 0.5f;
        }
        return sum / norm;
    }

    private static float ValueNoise(float x, float y, uint seed)
    {
        int x0 = (int)MathF.Floor(x), y0 = (int)MathF.Floor(y);
        float fx = x - x0, fy = y - y0;
        float sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);

        float a = Hash(x0, y0, seed), b = Hash(x0 + 1, y0, seed);
        float c = Hash(x0, y0 + 1, seed), d = Hash(x0 + 1, y0 + 1, seed);
        float top = a + (b - a) * sx, bottom = c + (d - c) * sx;
        return top + (bottom - top) * sy;
    }

    internal static float Hash(int x, int y, uint seed)
    {
        unchecked
        {
            uint h = (uint)x * 374761393u + (uint)y * 668265263u + seed * 2246822519u;
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xFFFFFF) / 16777215f;
        }
    }
}
