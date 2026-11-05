using System.Text;
using Godot;
using Survact.Game.Controls;
using Survact.Sim;

namespace Survact.Game.UI;

/// <summary>
/// Gameplay HUD. Layout and style live in Hud.tscn and ui/theme.tres; this script only fills text.
/// All player-facing strings go through Tr() with a string LITERAL (English source text) so
/// tools/i18n.py can extract them. Translations: game/i18n/*.po.
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
            // TRANSLATORS: HUD labels are short and uppercase; keep them under ~10 characters.
            .Append($"{Tr("DAY")} {sim.Day + 1,-3} {minutes / 60:00}:{minutes % 60:00}   {sim.Temperature,6:F1}°C\n")
            .Append($"{Tr("WOOD")} {col.Wood,-6} {Tr("FOOD")} {col.Food,-6}\n")
            .Append($"{Tr("ALIVE")} {sim.Colonists.Count,-5} {Tr("DEAD")} {col.Deaths,-5}\n")
            // TRANSLATORS: state of the heater, shown after "HEATER".
            .Append($"{Tr("HEATER")} {(col.HeaterLit ? Tr("ON") : Tr("OFF"))}   {Tr("SPEED")} x{speed}")
            .Append(paused ? $"  {Tr("PAUSED")}" : "")
            .Append($"\n{Tr("SIM")} {simMs,5:F2} ms   FPS {fps,4:F0}");

        _stats.Text = _sb.ToString();
    }

    /// <summary>Help line built from the live bindings: if a key is rebound, the hint follows.</summary>
    private void RefreshHelp()
    {
        // TRANSLATORS: key hints in the bottom bar, shown after the key name ("W move camera").
        (StringName Action, string Label)[] entries =
        [
            (Actions.CameraUp, Tr("move camera")),
            (Actions.Pause, Tr("pause")),
            (Actions.Speed1, Tr("speed (1/2/3)")),
            (Actions.QuickSave, Tr("save")),
            (Actions.QuickLoad, Tr("load")),
            (Actions.NewWorld, Tr("new world")),
            (Actions.DebugConsole, Tr("console")),
            (Actions.DebugOverlay, Tr("debug")),
        ];
        _help.Text = string.Join("   ", entries.Select(e => $"{InputBindings.LabelOf(e.Action)} {e.Label}"));
    }
}
