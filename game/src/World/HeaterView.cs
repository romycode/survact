using Godot;
using Survact.Sim;

namespace Survact.Game.World;

/// <summary>
/// The colony's heater (Heater.tscn): placed on the stockpile, its fire light and heat ring follow
/// the sim's heater state. The real light is what makes nights read: the colony is the bright spot.
/// </summary>
public partial class HeaterView : Node3D
{
    [Export] public float FireEnergy { get; set; } = 2.6f;
    [Export] public float Flicker { get; set; } = 0.35f;

    /// <summary>Radius the HeatRing mesh is modelled at, in tiles.</summary>
    private const float RingModelRadius = 6f;

    private Simulation? _sim;
    private OmniLight3D _fireLight = null!;
    private GeometryInstance3D _mouth = null!;
    private GeometryInstance3D _ember = null!;
    private GeometryInstance3D _ring = null!;
    private double _time;

    public override void _Ready()
    {
        _fireLight = GetNode<OmniLight3D>("FireLight");
        var caldera = GetNode<Node3D>("Caldera");
        _mouth = (GeometryInstance3D)caldera.FindChild("Mouth", recursive: true, owned: false);
        _ember = (GeometryInstance3D)caldera.FindChild("Ember", recursive: true, owned: false);
        _ring = GetNode<GeometryInstance3D>("HeatRing");
    }

    public void Bind(Simulation sim)
    {
        _sim = sim;
        float ground = Geometry.TerrainMesher.SurfaceAt(sim.Map, sim.Colony.StockX + 0.5f, sim.Colony.StockY + 0.5f);
        Position = new Vector3(sim.Colony.StockX + 0.5f, ground, sim.Colony.StockY + 0.5f);
        float k = sim.Balance.HeatRadius / RingModelRadius;
        _ring.Scale = new Vector3(k, 1, k);
        _fireLight.OmniRange = sim.Balance.HeatRadius + 2f;
    }

    public void Sync(double delta)
    {
        if (_sim is null) return;
        _time += delta;
        bool lit = _sim.Colony.HeaterLit;

        float flicker = 1f + Flicker * (Mathf.Sin((float)_time * 13.1f) * 0.5f + Mathf.Sin((float)_time * 7.3f) * 0.5f) * 0.5f;
        _fireLight.Visible = lit;
        _fireLight.LightEnergy = FireEnergy * flicker;
        _mouth.Visible = lit;
        _ember.Visible = lit;
        _ring.Transparency = lit ? 0.35f : 0.85f;
    }
}
