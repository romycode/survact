using Survact.Sim;
using Survact.Sim.World;
using Godot;

namespace Survact.Game;

/// <summary>
/// One 32x32 texture per chunk (1 pixel = 1 tile, scaled up with nearest filtering).
/// A chunk is re-uploaded only when its version changes, or when frost advances a step.
/// 64 chunks for a 256x256 map, so drawing the terrain is 64 sprites no matter what happens on it.
/// </summary>
public partial class TerrainRenderer : Node2D
{
    private const int Size = TileMap.ChunkSize;

    private Simulation? _sim;
    private Image[] _images = [];
    private ImageTexture[] _textures = [];
    private int[] _versions = [];
    private readonly byte[] _pixels = new byte[Size * Size * 4];
    private int _frostStep = -1;

    public void Bind(Simulation sim)
    {
        foreach (var child in GetChildren()) child.QueueFree();

        _sim = sim;
        var map = sim.Map;
        int chunks = map.ChunksX * map.ChunksY;
        _images = new Image[chunks];
        _textures = new ImageTexture[chunks];
        _versions = new int[chunks];
        _frostStep = FrostStep(sim.Temperature);

        for (int k = 0; k < chunks; k++)
        {
            Fill(k, FrostOf(_frostStep));
            _images[k] = Image.CreateFromData(Size, Size, false, Image.Format.Rgba8, _pixels);
            _textures[k] = ImageTexture.CreateFromImage(_images[k]);
            _versions[k] = map.ChunkVersion[k];

            AddChild(new Sprite2D
            {
                Texture = _textures[k],
                Centered = false,
                TextureFilter = TextureFilterEnum.Nearest,
                Scale = new Vector2(Main.TilePx, Main.TilePx),
                Position = new Vector2(k % map.ChunksX * Size, k / map.ChunksX * Size) * Main.TilePx,
            });
        }
    }

    public void Sync()
    {
        if (_sim is null) return;
        var map = _sim.Map;

        int frostStep = FrostStep(_sim.Temperature);
        bool all = frostStep != _frostStep;
        _frostStep = frostStep;
        float frost = FrostOf(frostStep);

        for (int k = 0; k < _textures.Length; k++)
        {
            int version = map.ChunkVersion[k];
            if (!all && version == _versions[k]) continue;

            _versions[k] = version;
            Fill(k, frost);
            _images[k].SetData(Size, Size, false, Image.Format.Rgba8, _pixels);
            _textures[k].Update(_images[k]);
        }
    }

    private void Fill(int chunk, float frost)
    {
        var map = _sim!.Map;
        int ox = chunk % map.ChunksX * Size, oy = chunk / map.ChunksX * Size;
        var px = _pixels.AsSpan();

        for (int y = 0; y < Size; y++)
        for (int x = 0; x < Size; x++)
        {
            int wx = ox + x, wy = oy + y;
            Palette.TilePixel(map.Get(wx, wy), wx, wy, frost, px.Slice((y * Size + x) * 4, 4));
        }
    }

    /// <summary>Frost advances in 2°C steps so the whole map is re-uploaded rarely, not every tick.</summary>
    private static int FrostStep(float temperature) => (int)MathF.Floor(Math.Clamp(5f - temperature, 0f, 40f) / 2f);

    private static float FrostOf(int step) => Math.Min(0.85f, step * 2f / 40f);
}
