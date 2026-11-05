using Survact.Sim.Entities;
using Survact.Sim.World;
using Godot;

namespace Survact.Game.World;

/// <summary>Limited, cold palette. Every colour on screen comes from here so the look stays coherent.</summary>
public static class Palette
{
    // Tile base colours (RGB bytes), indexed by Tile.
    private static readonly byte[][] TileRgb =
    [
        [74, 107, 58],    // Grass
        [43, 74, 111],    // Water
        [90, 90, 102],    // Rock
        [36, 64, 44],     // Tree
        [120, 92, 60],    // Bush (berries)
        [206, 214, 228],  // Snow
    ];

    private static readonly byte[] SnowRgb = [222, 228, 238];
    private static readonly byte[] IceRgb = [150, 184, 210];

    public static readonly Color Ui = new("#1b1e26");
    public static readonly Color UiBorder = new("#c8a464");
    public static readonly Color UiText = new("#e8dcc0");
    public static readonly Color UiDim = new("#8a8370");
    public static readonly Color Heat = new("#e8833a");
    public static readonly Color HeatOff = new("#5a6070");
    public static readonly Color Stockpile = new("#c8a464");

    /// <summary>
    /// Writes one tile pixel. <paramref name="frost"/> in [0,1]: share of ground covered by snow,
    /// water freezes past 0.5. Per-tile noise breaks the flat colour into a dithered retro texture.
    /// </summary>
    public static void TilePixel(Tile tile, int x, int y, float frost, Span<byte> rgba)
    {
        float noise = Hash(x, y);
        byte[] baseRgb = TileRgb[(int)tile];
        byte[] rgb = baseRgb;
        float shade = 0.9f + noise * 0.2f;

        bool snowCovered = tile is Tile.Grass or Tile.Bush && Hash(x * 7 + 3, y * 13 + 1) < frost;
        if (snowCovered) rgb = SnowRgb;
        else if (tile == Tile.Water && frost > 0.5f) rgb = IceRgb;

        float treeFrost = tile == Tile.Tree ? frost * 0.45f : 0f;
        for (int k = 0; k < 3; k++)
        {
            float v = rgb[k] + (SnowRgb[k] - rgb[k]) * treeFrost;
            rgba[k] = (byte)Math.Clamp(v * shade, 0, 255);
        }
        rgba[3] = 255;
    }

    private static readonly Color Gathering = new("#d9b26a");
    private static readonly Color Eating = new("#f2d55c");
    private static readonly Color Warming = new("#f08a4b");
    private static readonly Color CarryWood = new("#a8724a");
    private static readonly Color CarryFood = new("#d0505a");
    private static readonly Color Walking = new("#e8dcc0");
    private static readonly Color Idle = new("#9a9a9a");
    private static readonly Color Freezing = new("#7fb4ff");

    public static Color ColonistColor(ColonistState state, Job job, int carry, float warmth, float hunger)
    {
        Color c = state switch
        {
            ColonistState.Gathering => Gathering,
            ColonistState.Eating => Eating,
            ColonistState.Warming => Warming,
            ColonistState.Walking when carry > 0 && job == Job.Wood => CarryWood,
            ColonistState.Walking when carry > 0 => CarryFood,
            ColonistState.Walking => Walking,
            _ => Idle,
        };

        // Freezing colonists shift to icy blue, starving ones fade: readable at a glance.
        if (warmth < 0.35f) c = c.Lerp(Freezing, 1f - warmth / 0.35f);
        if (hunger < 0.35f) c = c.Darkened(0.5f * (1f - hunger / 0.35f));
        return c;
    }

    private static float Hash(int x, int y)
    {
        unchecked
        {
            uint h = (uint)x * 374761393u + (uint)y * 668265263u;
            h = (h ^ (h >> 13)) * 1274126177u;
            h ^= h >> 16;
            return (h & 0xFFFF) / 65535f;
        }
    }
}
