using System.Text;
using Godot;
using Survact.Sim;
using Survact.Sim.Pathfinding;

namespace Survact.Game.Debug;

/// <summary>
/// F3 overlay: per-system timings, pathfinding stats and everything the sim knows about the
/// tile under the cursor. The first place to look when "colonists are acting weird".
/// </summary>
public partial class DebugOverlay : CanvasLayer
{
    private Label _text = null!;
    private readonly StringBuilder _sb = new();

    public override void _Ready()
    {
        _text = GetNode<Label>("%Text");
        Visible = false;
    }

    public void Refresh(Simulation sim, Vector2I? tile, SystemProfiler profiler, double simMsPerTick)
    {
        _sb.Clear()
            .Append($"tick {sim.Tick}  day {sim.Day + 1}  {sim.Temperature:F1}°C (offset {sim.ClimateOffset:+0.0;-0.0;0})\n")
            .Append($"sim {simMsPerTick:F3} ms/tick  colonists {sim.Colonists.Count}\n");

        for (int i = 0; i < SystemProfiler.Names.Length; i++)
            _sb.Append($"  {SystemProfiler.Names[i],-9}{profiler.AverageMs(i):F3} ms\n");

        _sb.Append($"paths {sim.PathQueries} (failed {sim.PathFailures})  nodes/query {sim.PathNodesExpanded / Math.Max(1, sim.PathQueries)}\n")
           .Append($"flow field rebuilds {sim.FieldRebuilds}  regions {sim.Regions.RegionCount}\n")
           .Append($"command log {sim.CommandLog.Count}\n");

        if (tile is { } t)
        {
            var map = sim.Map;
            int idx = map.Index(t.X, t.Y);
            int region = sim.Regions.Of(idx);
            int dist = sim.StockpileField.DistanceAt(idx);
            float felt = sim.Temperature - sim.Balance.LapseRatePerLevel * map.LevelAt(idx);
            _sb.Append($"\ntile ({t.X},{t.Y})  {map.Get(idx)}  amount {map.AmountAt(idx)}{(map.IsReserved(idx) ? "  RESERVED" : "")}\n")
               .Append($"level {map.LevelAt(idx)}  felt {felt:F1}°C\n")
               .Append(BuildingLine(sim, map.BuildingAt(idx)))
               .Append($"region {(region == Regions.None ? "-" : region.ToString())}  to stockpile {(dist == FlowField.Unreachable ? "unreachable" : dist.ToString())}\n");
        }

        _text.Text = _sb.ToString();
    }

    private static string BuildingLine(Simulation sim, int id)
    {
        if (id < 0) return "";
        ref var b = ref sim.Buildings[id];
        var t = sim.Data.Buildings[b.Type];
        return $"building #{id} {t.Name} {b.Stage}  wood {b.Wood}+{b.WoodIncoming}/{t.WoodCost} haulers {b.Haulers}  " +
               $"work {b.Work}/{t.BuildTicks} builders {b.Builders}  inside {b.Occupants}/{t.ShelterCapacity}" +
               (t.IsShelter && b.Stage == Survact.Sim.Buildings.BuildingStage.Built ? $" at {sim.ShelterTemperature(id):F1}°C" : "") + "\n";
    }
}
