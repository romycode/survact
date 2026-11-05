using Survact.Sim;
using Godot;
using Survact.Game.Core;

namespace Survact.Game.World;

/// <summary>World-space markers: stockpile and heater radius. Redrawn only when something changes.</summary>
public partial class Overlay : Node2D
{
    private Simulation? _sim;
    private bool _lastLit;

    public void Bind(Simulation sim)
    {
        _sim = sim;
        _lastLit = sim.Colony.HeaterLit;
        QueueRedraw();
    }

    public void Sync()
    {
        if (_sim is null || _sim.Colony.HeaterLit == _lastLit) return;
        _lastLit = _sim.Colony.HeaterLit;
        QueueRedraw();
    }

    public override void _Draw()
    {
        if (_sim is null) return;
        var colony = _sim.Colony;
        const int px = RenderConfig.TilePx;
        var centre = new Vector2(colony.StockX + 0.5f, colony.StockY + 0.5f) * px;

        DrawArc(centre, _sim.Balance.HeatRadius * px, 0, Mathf.Tau, 64, _lastLit ? Palette.Heat : Palette.HeatOff, 2f);
        DrawRect(new Rect2(centre - new Vector2(px, px), new Vector2(px * 2, px * 2)), Palette.Stockpile, filled: false, width: 2f);
        DrawRect(new Rect2(centre - new Vector2(px / 2f, px / 2f), new Vector2(px, px)), _lastLit ? Palette.Heat : Palette.HeatOff);
    }
}
