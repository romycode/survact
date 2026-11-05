using Godot;
using Survact.Game.World.Geometry;
using Survact.Sim;
using Survact.Sim.World;

namespace Survact.Game.World;

/// <summary>
/// One MeshInstance3D per 32x32 chunk (frustum culling works per chunk). A chunk is re-meshed only
/// when its version changes, and at most <see cref="RebuildsPerFrame"/> per frame to avoid hitches.
/// Snow does NOT trigger rebuilds: it's done in the shader from a global uniform.
/// </summary>
public partial class TerrainView : Node3D
{
    [Export] public int RebuildsPerFrame { get; set; } = 4;

    private Simulation? _sim;
    private MeshInstance3D[] _chunks = [];
    private int[] _versions = [];

    public void Bind(Simulation sim)
    {
        foreach (var child in GetChildren()) child.QueueFree();
        _sim = sim;
        int count = sim.Map.ChunksX * sim.Map.ChunksY;
        _chunks = new MeshInstance3D[count];
        _versions = new int[count];

        for (int k = 0; k < count; k++)
        {
            _chunks[k] = new MeshInstance3D { Name = $"Chunk{k}" };
            AddChild(_chunks[k]);
            Rebuild(k);
        }
    }

    public void Sync()
    {
        if (_sim is null) return;
        int budget = RebuildsPerFrame;
        for (int k = 0; k < _chunks.Length && budget > 0; k++)
        {
            if (_sim.Map.ChunkVersion[k] == _versions[k]) continue;
            Rebuild(k);
            budget--;
        }
    }

    private void Rebuild(int chunk)
    {
        _versions[chunk] = _sim!.Map.ChunkVersion[chunk];
        _chunks[chunk].Mesh = MeshConvert.ToArrayMesh(TerrainMesher.BuildChunk(_sim.Map, chunk));
    }
}
