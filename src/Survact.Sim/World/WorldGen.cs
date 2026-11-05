namespace Survact.Sim.World;

/// <summary>Deterministic terrain from a seed: elevation + moisture value noise.</summary>
public static class WorldGen
{
    public static void Generate(TileMap map, uint seed)
    {
        for (int y = 0; y < map.Height; y++)
        for (int x = 0; x < map.Width; x++)
        {
            float elevation = Fbm(x / 48f, y / 48f, seed, 4);
            float moisture = Fbm(x / 28f, y / 28f, seed ^ 0x9E3779B9u, 3);
            float jitter = Hash(x, y, seed ^ 0x85EBCA6Bu);

            Tile tile;
            if (elevation < 0.30f) tile = Tile.Water;
            else if (elevation > 0.74f) tile = Tile.Rock;
            else if (elevation > 0.66f) tile = Tile.Snow;
            else if (moisture > 0.58f && jitter < 0.6f) tile = Tile.Tree;
            else if (moisture > 0.42f && jitter < 0.035f) tile = Tile.Bush;
            else tile = Tile.Grass;

            map.Set(map.Index(x, y), tile, TileRules.InitialAmount(tile));
        }
    }

    /// <summary>Guarantees a usable starting area around the stockpile.</summary>
    public static void ClearArea(TileMap map, int clearX, int clearY, int clearRadius)
    {
        for (int y = clearY - clearRadius; y <= clearY + clearRadius; y++)
        for (int x = clearX - clearRadius; x <= clearX + clearRadius; x++)
            if (map.InBounds(x, y))
                map.Set(map.Index(x, y), Tile.Grass, 0);
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
