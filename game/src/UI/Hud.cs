using System.Text;
using Godot;
using Survact.Game.Controls;
using Survact.Sim;

namespace Survact.Game.UI;

/// <summary>
/// Gameplay HUD. Layout and style live in Hud.tscn and ui/theme.tres; this script only fills text.
/// All player-facing strings go through Tr() (keys in i18n/strings.csv).
/// </summary>
public partial class Hud : CanvasLayer
{
    [Export] public double NotificationSeconds { get; set; } = 2.0;

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
            .Append($"{Tr("HUD_DAY")} {sim.Day + 1,-3} {minutes / 60:00}:{minutes % 60:00}   {sim.Temperature,6:F1}°C\n")
            .Append($"{Tr("HUD_WOOD")} {col.Wood,-6} {Tr("HUD_FOOD")} {col.Food,-6}\n")
            .Append($"{Tr("HUD_ALIVE")} {sim.Colonists.Count,-5} {Tr("HUD_DEAD")} {col.Deaths,-5}\n")
            .Append($"{Tr("HUD_HEATER")} {Tr(col.HeaterLit ? "HUD_ON" : "HUD_OFF")}   {Tr("HUD_SPEED")} x{speed}")
            .Append(paused ? $"  {Tr("HUD_PAUSED")}" : "")
            .Append($"\n{Tr("HUD_SIM")} {simMs,5:F2} ms   FPS {fps,4:F0}");

        _stats.Text = _sb.ToString();
    }

    /// <summary>Help line built from the live bindings: if a key is rebound, the hint follows.</summary>
    private void RefreshHelp()
    {
        (StringName Action, string Key)[] entries =
        [
            (Actions.CameraUp, "HELP_CAMERA"),
            (Actions.Pause, "HELP_PAUSE"),
            (Actions.Speed1, "HELP_SPEED"),
            (Actions.QuickSave, "HELP_SAVE"),
            (Actions.QuickLoad, "HELP_LOAD"),
            (Actions.NewWorld, "HELP_NEW_WORLD"),
            (Actions.DebugConsole, "HELP_CONSOLE"),
            (Actions.DebugOverlay, "HELP_DEBUG"),
        ];
        _help.Text = string.Join("   ", entries.Select(e => $"{InputBindings.LabelOf(e.Action)} {Tr(e.Key)}"));
    }
}
