using Godot;
using Survact.Game.World.Geometry;
using Survact.Sim;
using Survact.Sim.Buildings;

namespace Survact.Game.World;

/// <summary>
/// One small node tree per building (buildings are few; colonists and trees are the many-instance
/// case and use MultiMesh). Construction sites show a plank foundation, the delivered log pile and
/// the model rising with work progress. Shelters glow at night when someone is inside.
/// Structure is rebuilt only when BuildingStore.Version changes; progress/lights update per frame.
/// </summary>
public partial class BuildingView : Node3D
{
    private sealed class Entry
    {
        public required Node3D Root;
        public required Node3D Model;
        public required MeshInstance3D Foundation;
        public required MeshInstance3D Logs;
        public MeshInstance3D? Window;
        public OmniLight3D? Light;
        public BuildingStage Stage;
    }

    private Simulation? _sim;
    private readonly List<Entry?> _entries = [];
    private Mesh? _logs;
    private int _version = -1;

    public void Bind(Simulation sim)
    {
        foreach (var child in GetChildren()) child.QueueFree();
        _entries.Clear();
        _sim = sim;
        _version = -1;
    }

    public void Sync()
    {
        if (_sim is null) return;
        var store = _sim.Buildings;

        if (store.Version != _version)
        {
            _version = store.Version;
            for (int id = 0; id < store.Count; id++) SyncStructure(id);
        }

        bool night = _sim.IsNight;
        for (int id = 0; id < _entries.Count; id++)
        {
            var e = _entries[id];
            if (e is null) continue;
            ref var b = ref store[id];
            var type = _sim.Data.Buildings[b.Type];

            if (b.Stage == BuildingStage.Site)
            {
                float wood = type.WoodCost == 0 ? 1f : (float)b.Wood / type.WoodCost;
                float work = (float)b.Work / type.BuildTicks;
                e.Logs.Visible = wood > 0 && work < 1f;
                e.Logs.Scale = new Vector3(1, Mathf.Max(0.15f, wood), 1);
                e.Model.Visible = work > 0;
                e.Model.Scale = new Vector3(1, Mathf.Clamp(work, 0.04f, 1f), 1);
            }

            bool glow = b.Stage == BuildingStage.Built && night && b.Occupants > 0;
            if (e.Window is not null) e.Window.Visible = glow;
            if (e.Light is not null) e.Light.Visible = glow;
        }
    }

    private void SyncStructure(int id)
    {
        var store = _sim!.Buildings;
        ref var b = ref store[id];
        while (_entries.Count <= id) _entries.Add(null);
        var e = _entries[id];

        if (b.Stage == BuildingStage.Removed)
        {
            e?.Root.QueueFree();
            _entries[id] = null;
            return;
        }

        e ??= _entries[id] = Create(id);
        if (e.Stage == b.Stage) return;
        e.Stage = b.Stage;

        bool site = b.Stage == BuildingStage.Site;
        e.Foundation.Visible = site;
        e.Logs.Visible = site;
        if (!site)
        {
            e.Model.Visible = true;
            e.Model.Scale = Vector3.One;
        }
    }

    private Entry Create(int id)
    {
        ref var b = ref _sim!.Buildings[id];
        var type = _sim.Data.Buildings[b.Type];
        _logs ??= VerticalSliceArt.LoadMesh("Survact-madera-entregada-v01.glb");

        float ground = TerrainMesher.SurfaceAt(_sim.Map, b.X + type.Width / 2f, b.Y + type.Height / 2f);
        var root = new Node3D { Name = $"Building{id}", Position = new Vector3(b.X, ground, b.Y) };
        var model = VerticalSliceArt.Shelter(type.Name, type.Width, type.Height);
        model.Name = "Model";
        var foundation = new MeshInstance3D
        {
            Name = "Foundation",
            Mesh = VerticalSliceArt.Foundation(type.Width, type.Height),
        };
        var logs = new MeshInstance3D
        {
            Name = "Logs", Mesh = _logs,
            Position = new Vector3(type.Width / 2f, 0.1f, type.Height + 0.45f),
        };
        root.AddChild(foundation);
        root.AddChild(model);
        root.AddChild(logs);

        var entry = new Entry { Root = root, Model = model, Foundation = foundation, Logs = logs, Stage = (BuildingStage)255 };
        if (model.FindChild("WindowLit", recursive: true, owned: false) is MeshInstance3D window)
        {
            window.Visible = false;
            window.CastShadow = GeometryInstance3D.ShadowCastingSetting.Off;
            entry.Window = window;
            entry.Light = new OmniLight3D
            {
                Name = "Light", Visible = false, LightColor = new Color(1f, 0.7f, 0.4f), LightEnergy = 0.9f,
                OmniRange = 3.2f, Position = new Vector3(0.61f, 0.71f, 2.1f),
            };
            root.AddChild(entry.Light);
        }
        AddChild(root);
        return entry;
    }
}
