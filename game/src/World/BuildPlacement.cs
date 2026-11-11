using Godot;
using Survact.Game.Controls;
using Survact.Game.World.Geometry;
using Survact.Sim;
using Survact.Sim.Buildings;
using Survact.Sim.Commands;

namespace Survact.Game.World;

/// <summary>
/// Build tool. While a building type is selected, a translucent ghost follows the cursor snapped to
/// the grid: green where BuildRules allows it, red otherwise, with the footprint and the entrance
/// marked. Click places (stays in build mode, Factorio-style); right click / Esc exits.
/// Outside build mode, Delete over a construction site cancels it.
/// Lives inside the 3D SubViewport so it receives world clicks after the UI had its chance.
/// Never changes the sim directly: it enqueues PlaceBuilding / CancelBuilding commands.
/// </summary>
public partial class BuildPlacement : Node3D
{
    [Signal] public delegate void ToolChangedEventHandler(int type);
    [Signal] public delegate void PlacementFailedEventHandler(int error);
    [Signal] public delegate void SiteCancelledEventHandler();

    private static readonly Color Valid = new(0.35f, 0.95f, 0.45f, 0.45f);
    private static readonly Color Invalid = new(1f, 0.3f, 0.25f, 0.45f);

    private Simulation? _sim;
    private CameraRig _camera = null!;
    private Node3D _ghost = null!;
    private MeshInstance3D _footprint = null!;
    private MeshInstance3D _entrance = null!;
    private StandardMaterial3D _material = null!;

    /// <summary>Selected building type, or -1 when not in build mode.</summary>
    public int Type { get; private set; } = -1;

    /// <summary>Result of the rules check at the current cursor position (None when not placing).</summary>
    public PlacementError Error { get; private set; }

    /// <summary>Top-left tile of the ghost, when it is over the map.</summary>
    public Vector2I? Origin { get; private set; }

    public override void _Ready()
    {
        _material = new StandardMaterial3D
        {
            Transparency = BaseMaterial3D.TransparencyEnum.Alpha,
            ShadingMode = BaseMaterial3D.ShadingModeEnum.Unshaded,
            AlbedoColor = Valid,
        };
        _ghost = new Node3D { Name = "Ghost" };
        AddChild(_ghost);
        _footprint = NewPart("Footprint");
        _entrance = NewPart("Entrance");
        _entrance.Mesh = new BoxMesh { Size = new Vector3(0.36f, 0.08f, 0.36f) };
        Visible = false;
    }

    public void Bind(Simulation sim, CameraRig camera)
    {
        _sim = sim;
        _camera = camera;
        SetTool(-1);
    }

    public void SetTool(int type)
    {
        if (_sim is null) return;
        Type = type >= 0 && type < _sim.Data.Buildings.Count ? type : -1;
        Visible = Type >= 0;
        Error = PlacementError.None;
        foreach (var child in _ghost.GetChildren())
        {
            _ghost.RemoveChild(child);
            child.QueueFree();
        }
        if (Type >= 0)
        {
            var t = _sim.Data.Buildings[Type];
            var model = VerticalSliceArt.Shelter(t.Name, t.Width, t.Height);
            if (model is MeshInstance3D singleMesh) StyleGhost(singleMesh);
            foreach (var child in model.FindChildren("*", "MeshInstance3D", recursive: true, owned: false))
                StyleGhost((MeshInstance3D)child);
            _ghost.AddChild(model);
            _footprint.Mesh = new BoxMesh { Size = new Vector3(t.Width, 0.06f, t.Height) };
        }
        EmitSignal(SignalName.ToolChanged, Type);
    }

    public override void _Process(double delta)
    {
        if (_sim is null || Type < 0) return;
        Origin = null;
        if (!_camera.TryGetGroundUnderMouse(out var p))
        {
            Visible = false;
            return;
        }

        var t = _sim.Data.Buildings[Type];
        // Centre the footprint on the cursor tile (for even sizes, the cursor is the south-east middle tile).
        int x = Mathf.FloorToInt(p.X) - (t.Width - 1) / 2;
        int y = Mathf.FloorToInt(p.Z) - (t.Height - 1) / 2;
        Origin = new Vector2I(x, y);
        Error = BuildRules.Check(_sim, Type, x, y);

        var map = _sim.Map;
        float ground = TerrainMesher.SurfaceAt(map, Math.Clamp(x + t.Width / 2f, 0, map.Width - 1), Math.Clamp(y + t.Height / 2f, 0, map.Height - 1));
        Visible = true;
        _material.AlbedoColor = Error == PlacementError.None ? Valid : Invalid;
        _ghost.Position = new Vector3(x, ground + 0.02f, y);
        _footprint.Position = new Vector3(x + t.Width / 2f, ground + 0.03f, y + t.Height / 2f);
        float ex = x + t.Width / 2 + 0.5f, ez = y + t.Height + 0.5f;
        _entrance.Position = new Vector3(ex, TerrainMesher.SurfaceAt(map, Math.Clamp(ex, 0, map.Width - 1), Math.Clamp(ez, 0, map.Height - 1)) + 0.05f, ez);
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        if (_sim is null) return;

        if (Type >= 0)
        {
            if (@event.IsActionPressed(Actions.BuildPlace)) TryPlace();
            else if (@event.IsActionPressed(Actions.BuildExit)) SetTool(-1);
            else return;
            GetViewport().SetInputAsHandled();
            return;
        }

        if (@event.IsActionPressed(Actions.BuildCancelSite) && SiteUnderMouse() is int site)
        {
            _sim.Enqueue(Command.CancelBuilding(site));
            EmitSignal(SignalName.SiteCancelled);
            GetViewport().SetInputAsHandled();
        }
    }

    private void TryPlace()
    {
        if (Origin is not { } o) return;
        if (Error != PlacementError.None)
        {
            EmitSignal(SignalName.PlacementFailed, (int)Error);
            return;
        }
        _sim!.Enqueue(Command.PlaceBuilding(Type, o.X, o.Y));
    }

    private int? SiteUnderMouse()
    {
        if (!_camera.TryGetGroundUnderMouse(out var p)) return null;
        int x = Mathf.FloorToInt(p.X), y = Mathf.FloorToInt(p.Z);
        if (!_sim!.Map.InBounds(x, y)) return null;
        int id = _sim.Map.BuildingAt(_sim.Map.Index(x, y));
        return id >= 0 && _sim.Buildings[id].Stage == BuildingStage.Site ? id : null;
    }

    private void StyleGhost(MeshInstance3D mesh)
    {
        mesh.Visible = mesh.Name != "WindowLit";
        mesh.MaterialOverride = _material;
        mesh.CastShadow = GeometryInstance3D.ShadowCastingSetting.Off;
    }

    private MeshInstance3D NewPart(string name)
    {
        var part = new MeshInstance3D
        {
            Name = name, MaterialOverride = _material, CastShadow = GeometryInstance3D.ShadowCastingSetting.Off,
        };
        AddChild(part);
        return part;
    }
}
