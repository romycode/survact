using Godot;
using Survact.Game.World.Geometry;
using Survact.Sim;
using Survact.Sim.World;

namespace Survact.Game.World;

/// <summary>
/// Trees, bushes and boulders as one MultiMesh per chunk and species: a forest is a handful of draw calls,
/// and when a tree is cut only its chunk's instance list is rewritten.
/// Next step if dense maps get heavy: distance-based LOD (impostor quads far from the camera).
/// </summary>
public partial class VegetationView : Node3D
{
    private static readonly (Tile Tile, string File)[] Species =
    [
        (Tile.Tree, "Survact-pino-v01.glb"),
        (Tile.Bush, "Survact-arbusto-bayas-v01.glb"),
        (Tile.Rock, "Survact-penasco-v01.glb"),
    ];

    private Simulation? _sim;
    private Mesh[] _meshes = [];
    private MultiMeshInstance3D[,] _instances = new MultiMeshInstance3D[0, 0];
    private int[] _versions = [];
    private readonly List<Scatter.Instance> _scratch = [];

    public override void _Ready()
    {
        _meshes = new Mesh[Species.Length];
        for (int i = 0; i < Species.Length; i++)
        {
            var species = Species[i];
            var mesh = VerticalSliceArt.LoadMesh(species.File);
            mesh.SurfaceSetMaterial(0, MeshConvert.LowPolyMaterial);
            _meshes[i] = mesh;
        }
    }

    public void Bind(Simulation sim)
    {
        foreach (var child in GetChildren()) child.QueueFree();
        _sim = sim;
        int chunks = sim.Map.ChunksX * sim.Map.ChunksY;
        _instances = new MultiMeshInstance3D[chunks, Species.Length];
        _versions = new int[chunks];

        for (int k = 0; k < chunks; k++)
        {
            for (int s = 0; s < Species.Length; s++)
            {
                var mmi = new MultiMeshInstance3D
                {
                    Name = $"{Species[s].Tile}{k}",
                    Multimesh = new MultiMesh { TransformFormat = MultiMesh.TransformFormatEnum.Transform3D, Mesh = _meshes[s] },
                };
                _instances[k, s] = mmi;
                AddChild(mmi);
            }
            Rebuild(k);
        }
    }

    public void Sync()
    {
        if (_sim is null) return;
        for (int k = 0; k < _versions.Length; k++)
            if (_sim.Map.ChunkVersion[k] != _versions[k]) Rebuild(k);
    }

    private void Rebuild(int chunk)
    {
        _versions[chunk] = _sim!.Map.ChunkVersion[chunk];
        for (int s = 0; s < Species.Length; s++)
        {
            Scatter.Collect(_sim.Map, chunk, Species[s].Tile, _scratch);
            var mm = _instances[chunk, s].Multimesh;
            mm.InstanceCount = _scratch.Count;
            for (int i = 0; i < _scratch.Count; i++)
            {
                var inst = _scratch[i];
                var basis = new Basis(Vector3.Up, inst.Yaw).Scaled(new Vector3(inst.Scale, inst.Scale, inst.Scale));
                mm.SetInstanceTransform(i, new Transform3D(basis, new Vector3(inst.Position.X, inst.Position.Y, inst.Position.Z)));
            }
        }
    }
}
