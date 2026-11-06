using Godot;
using Survact.Game.World.Geometry;
using Survact.Sim;
using Survact.Sim.Entities;

namespace Survact.Game.World;

/// <summary>
/// All colonists in ONE draw call (MultiMeshInstance3D, per-instance color = job/state).
/// Positions interpolate between the previous and current tick so motion is smooth at any
/// framerate while the sim runs at a fixed 30 Hz. Colonists face where they walk.
/// </summary>
public partial class ColonistView : MultiMeshInstance3D
{
    private Simulation? _sim;
    private MultiMesh _mesh = null!;
    private float[] _yaw = new float[64];
    private float[] _height = new float[64];

    public override void _Ready()
    {
        _mesh = new MultiMesh
        {
            TransformFormat = MultiMesh.TransformFormatEnum.Transform3D,
            UseColors = true,
            Mesh = MeshConvert.ToArrayMesh(LowPoly.Colonist()),
        };
        Multimesh = _mesh;
    }

    public void Bind(Simulation sim) => _sim = sim;

    public void Sync(float alpha, double delta)
    {
        if (_sim is null) return;
        var c = _sim.Colonists;
        var map = _sim.Map;
        int n = c.Count;

        if (_mesh.InstanceCount < n) _mesh.InstanceCount = (int)System.Numerics.BitOperations.RoundUpToPowerOf2((uint)Math.Max(n, 64));
        if (_yaw.Length < _mesh.InstanceCount)
        {
            Array.Resize(ref _yaw, _mesh.InstanceCount);
            Array.Resize(ref _height, _mesh.InstanceCount);
        }
        float follow = 1f - Mathf.Exp(-20f * (float)delta); // ramps are continuous; this only softens cliff-edge teleports
        _mesh.VisibleInstanceCount = n;

        for (int i = 0; i < n; i++)
        {
            float dx = c.X[i] - c.PrevX[i], dz = c.Y[i] - c.PrevY[i];
            if (dx * dx + dz * dz > 1e-6f) _yaw[i] = Mathf.Atan2(dx, dz);

            float x = c.PrevX[i] + dx * alpha;
            float z = c.PrevY[i] + dz * alpha;
            float ground = TerrainMesher.SurfaceAt(map, x, z);
            _height[i] = Mathf.Abs(_height[i] - ground) > 3f ? ground : Mathf.Lerp(_height[i], ground, follow);

            // Sheltered colonists are inside a building: collapse their instance to hide it.
            var basis = c.State[i] == ColonistState.Sheltered ? new Basis(Vector3.Up, 0).Scaled(Vector3.Zero) : new Basis(Vector3.Up, _yaw[i]);
            _mesh.SetInstanceTransform(i, new Transform3D(basis, new Vector3(x, _height[i], z)));
            _mesh.SetInstanceColor(i, Palette.ColonistColor(c.State[i], c.Job[i], c.Carry[i], c.Warmth[i], c.Hunger[i]));
        }
    }
}
