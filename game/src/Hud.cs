using System.Text;
using Survact.Sim;
using Godot;

namespace Survact.Game;

/// <summary>
/// Retro panel: flat dark box, hard 2px gold border, no rounding, monospace text.
/// Built in code for now; move to a .tscn + Theme resource once the UI grows.
/// Drop a pixel font (e.g. a .ttf with antialiasing off) into the theme to finish the look.
/// </summary>
public partial class Hud : CanvasLayer
{
    private Label _stats = null!;
    private Label _flash = null!;
    private double _flashLeft;
    private readonly StringBuilder _sb = new();

    public override void _Ready()
    {
        var font = new SystemFont { FontNames = ["monospace"], Antialiasing = TextServer.FontAntialiasing.None };

        var panel = new PanelContainer { Position = new Vector2(12, 12) };
        panel.AddThemeStyleboxOverride("panel", new StyleBoxFlat
        {
            BgColor = Palette.Ui with { A = 0.92f },
            BorderColor = Palette.UiBorder,
            BorderWidthLeft = 2, BorderWidthTop = 2, BorderWidthRight = 2, BorderWidthBottom = 2,
            ContentMarginLeft = 12, ContentMarginTop = 8, ContentMarginRight = 12, ContentMarginBottom = 8,
        });
        AddChild(panel);

        _stats = NewLabel(font, Palette.UiText);
        panel.AddChild(_stats);

        _flash = NewLabel(font, Palette.UiBorder);
        _flash.AnchorTop = _flash.AnchorBottom = 1f;
        _flash.OffsetTop = -44;
        _flash.OffsetLeft = 12;
        AddChild(_flash);

        var help = NewLabel(font, Palette.UiDim);
        help.Text = "WASD pan  wheel zoom  SPACE pause  1/2/3 speed  F5 save  F9 load  N new world";
        help.AnchorTop = help.AnchorBottom = 1f;
        help.OffsetTop = -24;
        help.OffsetLeft = 12;
        AddChild(help);
    }

    public override void _Process(double delta)
    {
        if (_flashLeft <= 0) return;
        _flashLeft -= delta;
        if (_flashLeft <= 0) _flash.Text = "";
    }

    public void Flash(string message)
    {
        _flash.Text = message;
        _flashLeft = 2.0;
    }

    public void Refresh(Simulation sim, int speed, bool paused, double simMs, double fps, SystemProfiler profiler)
    {
        int minutes = (int)(sim.TimeOfDay * 24 * 60);
        var col = sim.Colony;

        _sb.Clear()
            .Append($"DAY {sim.Day + 1,-3} {minutes / 60:00}:{minutes % 60:00}   {sim.Temperature,6:F1}°C\n")
            .Append($"WOOD {col.Wood,-6} FOOD {col.Food,-6}\n")
            .Append($"ALIVE {sim.Colonists.Count,-5} DEAD {col.Deaths,-5}\n")
            .Append($"HEATER {(col.HeaterLit ? "ON " : "OFF")}  SPEED x{speed}{(paused ? "  PAUSED" : "")}\n")
            .Append($"SIM {simMs,5:F2} ms/tick   FPS {fps,4:F0}");

        if (simMs > 1.0) _sb.Append('\n').Append(profiler.ToString());
        _stats.Text = _sb.ToString();
    }

    private static Label NewLabel(Font font, Color color)
    {
        var label = new Label();
        label.AddThemeFontOverride("font", font);
        label.AddThemeFontSizeOverride("font_size", 14);
        label.AddThemeColorOverride("font_color", color);
        return label;
    }
}
