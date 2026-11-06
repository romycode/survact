using System.Text;
using Godot;
using Survact.Game.Controls;
using Survact.Sim;
using Survact.Sim.Buildings;
using Survact.Sim.Entities;

namespace Survact.Game.UI;

/// <summary>
/// Gameplay HUD. Layout and style live in Hud.tscn and ui/theme.tres; this script only fills text.
/// All player-facing strings go through Tr() with a string LITERAL (English source text) so
/// tools/i18n.py can extract them. Translations: game/i18n/*.po.
/// </summary>
public partial class Hud : CanvasLayer
{
    /// <summary>A toolbar button was pressed: the building type to place.</summary>
    [Signal] public delegate void BuildSelectedEventHandler(int type);

    [Export] public double NotificationSeconds { get; set; } = 2.0;

    private Container _toolbar = null!;
    private Label _buildInfo = null!;
    private readonly List<(int Type, Button Button)> _tools = [];

    private Label _stats = null!;
    private Label _notification = null!;
    private Label _help = null!;
    private double _notificationLeft;
    private readonly StringBuilder _sb = new();

    public override void _Ready()
    {
        _stats = GetNode<Label>("%Stats");
        _notification = GetNode<Label>("%Notification");
        _help = GetNode<Label>("%Help");
        _toolbar = GetNode<Container>("%Toolbar");
        _buildInfo = GetNode<Label>("%BuildInfo");
        _buildInfo.Text = "";
        _notification.Text = "";
        RefreshHelp();
    }

    public override void _Notification(int what)
    {
        // Rebuild translated static text when the language changes at runtime.
        if (what == NotificationTranslationChanged && _help is not null) RefreshHelp();
    }

    public override void _Process(double delta)
    {
        if (_notificationLeft <= 0) return;
        _notificationLeft -= delta;
        if (_notificationLeft <= 0) _notification.Text = "";
    }

    public void Notify(string message)
    {
        _notification.Text = message;
        _notificationLeft = NotificationSeconds;
    }

    public void Refresh(Simulation sim, int speed, bool paused, double simMs, double fps)
    {
        int minutes = (int)(sim.TimeOfDay * 24 * 60);
        var col = sim.Colony;

        _sb.Clear()
            // TRANSLATORS: HUD labels are short and uppercase; keep them under ~10 characters.
            .Append($"{Tr("DAY")} {sim.Day + 1,-3} {minutes / 60:00}:{minutes % 60:00}   {sim.Temperature,6:F1}°C\n")
            .Append($"{Tr("WOOD")} {col.Wood,-6} {Tr("FOOD")} {col.Food,-6}\n")
            .Append($"{Tr("ALIVE")} {sim.Colonists.Count,-5} {Tr("DEAD")} {col.Deaths,-5}\n")
            // TRANSLATORS: colonists inside shelters / total shelter places.
            .Append($"{Tr("SHELTER")} {Sheltered(sim)}/{ShelterCapacity(sim)}\n")
            // TRANSLATORS: state of the heater, shown after "HEATER".
            .Append($"{Tr("HEATER")} {(col.HeaterLit ? Tr("ON") : Tr("OFF"))}   {Tr("SPEED")} x{speed}")
            .Append(paused ? $"  {Tr("PAUSED")}" : "")
            .Append($"\n{Tr("SIM")} {simMs,5:F2} ms   FPS {fps,4:F0}");

        _stats.Text = _sb.ToString();
    }

    /// <summary>Toolbar from the game data: one button per building type, cheapest first, with its hotkey.</summary>
    public void BindBuildTools(Simulation sim)
    {
        foreach (var (_, button) in _tools) button.QueueFree();
        _tools.Clear();

        var types = sim.Data.Buildings.All.OrderBy(t => t.WoodCost).ThenBy(t => t.Name, StringComparer.Ordinal).ToList();
        for (int k = 0; k < types.Count; k++)
        {
            var t = types[k];
            string key = k < Actions.BuildSlots.Length ? InputBindings.LabelOf(Actions.BuildSlots[k]) : "";
            var button = new Button
            {
                ToggleMode = true,
                FocusMode = Control.FocusModeEnum.None,
                Text = $"{Texts.Building(this, t.Name)}  {t.WoodCost} {Tr("wood")}  [{key}]",
            };
            int type = t.Index;
            button.Pressed += () => EmitSignal(SignalName.BuildSelected, type);
            _toolbar.AddChild(button);
            _tools.Add((type, button));
        }
    }

    /// <summary>Building type for toolbar slot k (hotkeys), or -1.</summary>
    public int ToolAt(int slot) => slot >= 0 && slot < _tools.Count ? _tools[slot].Type : -1;

    public void SetActiveTool(int type)
    {
        foreach (var (t, button) in _tools) button.SetPressedNoSignal(t == type);
        if (type < 0) _buildInfo.Text = "";
    }

    /// <summary>Build-mode hint under the cursor's ghost: what it is, what it costs, how warm, and why not.</summary>
    public void RefreshBuildInfo(Simulation sim, int type, Vector2I? origin, PlacementError error)
    {
        if (type < 0)
        {
            _buildInfo.Text = "";
            return;
        }

        var t = sim.Data.Buildings[type];
        string line = $"{Texts.Building(this, t.Name)} · {t.WoodCost} {Tr("wood")}";
        if (t.IsShelter && origin is { } o)
            line += $" · {Tr("sleeps")} {t.ShelterCapacity} · +{sim.ShelterWarmth(type, o.X, o.Y):F0}°C";
        line += error == PlacementError.None
            ? $"   [{Tr("click: build · right click: done")}]"
            : $"   ✕ {Texts.Placement(this, error)}";
        _buildInfo.Text = line;
    }

    private static int Sheltered(Simulation sim)
    {
        int n = 0;
        var c = sim.Colonists;
        for (int i = 0; i < c.Count; i++) if (c.State[i] == ColonistState.Sheltered) n++;
        return n;
    }

    private static int ShelterCapacity(Simulation sim)
    {
        int n = 0;
        for (int id = 0; id < sim.Buildings.Count; id++)
        {
            ref var b = ref sim.Buildings[id];
            if (b.Stage == BuildingStage.Built) n += sim.Data.Buildings[b.Type].ShelterCapacity;
        }
        return n;
    }

    /// <summary>Help line built from the live bindings: if a key is rebound, the hint follows.</summary>
    private void RefreshHelp()
    {
        // TRANSLATORS: key hints in the bottom bar, shown after the key name ("W move camera").
        (StringName Action, string Label)[] entries =
        [
            (Actions.CameraUp, Tr("move camera")),
            (Actions.CameraRotateLeft, Tr("rotate")),
            (Actions.Pause, Tr("pause")),
            (Actions.Speed1, Tr("speed (1/2/3)")),
            (Actions.QuickSave, Tr("save")),
            (Actions.QuickLoad, Tr("load")),
            (Actions.NewWorld, Tr("new world")),
            (Actions.BuildCancelSite, Tr("cancel construction")),
            (Actions.DebugConsole, Tr("console")),
            (Actions.DebugOverlay, Tr("debug")),
        ];
        _help.Text = string.Join("   ", entries.Select(e => $"{InputBindings.LabelOf(e.Action)} {e.Label}"));
    }
}
