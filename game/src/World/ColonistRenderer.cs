using Survact.Sim;
using Godot;
using Survact.Game.Core;

namespace Survact.Game.World;

/// <summary>
/// All colonists in ONE draw call via MultiMesh. Never one Node per entity: 5,000 Nodes would
/// cost more than the whole simulation. Positions are interpolated between the previous and
/// current tick so movement is smooth at any framerate while the sim runs at a fixed 30 Hz.
/// Next optimisation if needed: write MultiMesh.Buffer in one call instead of per-instance setters.
/// </summary>
public partial class ColonistRenderer : MultiMeshInstance2D
{
    private Simulation? _sim;
    private MultiMesh _mesh = null!;

    public override void _Ready()
    {
        _mesh = new MultiMesh
        {
            TransformFormat = MultiMesh.TransformFormatEnum.Transform2D,
            UseColors = true,
            Mesh = new QuadMesh { Size = new Vector2(RenderConfig.TilePx * 0.75f, RenderConfig.TilePx * 0.75f) },
        };
        Multimesh = _mesh;
    }

    public void Bind(Simulation sim) => _sim = sim;

    public void Sync(float alpha)
    {
        if (_sim is null) return;
        var c = _sim.Colonists;
        int n = c.Count;

        if (_mesh.InstanceCount < n) _mesh.InstanceCount = (int)System.Numerics.BitOperations.RoundUpToPowerOf2((uint)Math.Max(n, 64));
        _mesh.VisibleInstanceCount = n;

        for (int i = 0; i < n; i++)
        {
            float x = c.PrevX[i] + (c.X[i] - c.PrevX[i]) * alpha;
            float y = c.PrevY[i] + (c.Y[i] - c.PrevY[i]) * alpha;
            _mesh.SetInstanceTransform2D(i, new Transform2D(0f, new Vector2(x, y) * RenderConfig.TilePx));
            _mesh.SetInstanceColor(i, Palette.ColonistColor(c.State[i], c.Job[i], c.Carry[i], c.Warmth[i], c.Hunger[i]));
        }
    }
}
