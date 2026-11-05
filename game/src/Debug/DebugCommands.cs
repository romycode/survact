using System.Globalization;
using Survact.Sim.Commands;

namespace Survact.Game.Debug;

/// <summary>
/// Developer console commands. Anything that changes the world goes through the simulation's
/// command queue (Command.*), so cheats are validated, logged and replayable like player actions.
/// Presentation-only commands (speed, camera, overlay) talk to the host directly.
/// Dev tool: output is intentionally not localized.
/// </summary>
public static class DebugCommands
{
    private delegate string Handler(string[] args, IDebugHost host);

    private sealed record Entry(string Usage, string Help, Handler Run);

    private static readonly SortedDictionary<string, Entry> Registry = new(StringComparer.OrdinalIgnoreCase)
    {
        ["help"] = new("help", "list commands", (_, _) => HelpText()),
        ["spawn"] = new("spawn <count> [x y]", "spawn colonists (default: at the stockpile)", Spawn),
        ["give"] = new("give <wood|food> <amount>", "add stock (negative removes)", Give),
        ["cold"] = new("cold <degrees>", "shift the climate curve (e.g. cold -15)", Cold),
        ["speed"] = new("speed <1|3|10>", "set simulation speed", Speed),
        ["pause"] = new("pause", "toggle pause", (_, h) => { h.TogglePause(); return h.Paused ? "paused" : "running"; }),
        ["step"] = new("step [ticks]", "advance N ticks (default 1); use while paused", Step),
        ["goto"] = new("goto <x> <y>", "center the camera on a tile", Goto),
        ["hash"] = new("hash", "print the full-state hash (compare between machines/replays)", (_, h) => $"tick {h.Sim.Tick}  hash {h.Sim.StateHash():X16}"),
        ["log"] = new("log", "print the replay command log", PrintLog),
        ["seed"] = new("seed", "print the world seed", (_, h) => h.Sim.Settings.Seed.ToString(CultureInfo.InvariantCulture)),
        ["new"] = new("new [seed]", "start a new world", NewWorld),
        ["save"] = new("save", "quick save", (_, h) => { h.QuickSave(); return "saved"; }),
        ["load"] = new("load", "quick load", (_, h) => h.QuickLoad() ? "loaded" : Error("load failed")),
        ["pixel"] = new("pixel <1-6>", "3D render scale (1 = native, 3 = default retro)", (a, h) => { h.PixelScale = Math.Clamp(Int(a[0]), 1, 6); return $"pixel scale {h.PixelScale}"; }),
        ["retro"] = new("retro [on|off]", "toggle the posterize/dither filter", Retro),
        ["camera"] = new("camera <oblique|perspective>", "oblique = Factorio-like ortho, Q/E 90° steps; perspective = free orbit", CameraMode),
        ["overlay"] = new("overlay", "toggle the debug overlay (also F3)", (_, h) => { h.ToggleDebugOverlay(); return "ok"; }),
        ["clear"] = new("clear", "clear the console", (_, h) => { h.ClearConsole(); return ""; }),
    };

    public static string Execute(string line, IDebugHost host)
    {
        string[] parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0) return "";
        if (!Registry.TryGetValue(parts[0], out var entry)) return Error($"unknown command '{parts[0]}' (try 'help')");

        try
        {
            return entry.Run(parts[1..], host);
        }
        catch (FormatException)
        {
            return Error($"usage: {entry.Usage}");
        }
        catch (IndexOutOfRangeException)
        {
            return Error($"usage: {entry.Usage}");
        }
    }

    private static string HelpText() =>
        string.Join("\n", Registry.Values.Select(e => $"[color=#c8a464]{e.Usage,-28}[/color] {e.Help}"));

    private static string Spawn(string[] a, IDebugHost h)
    {
        int count = Int(a[0]);
        var colony = h.Sim.Colony;
        int x = a.Length >= 3 ? Int(a[1]) : colony.StockX;
        int y = a.Length >= 3 ? Int(a[2]) : colony.StockY;
        h.Sim.Enqueue(Command.SpawnColonists(x, y, count));
        return $"queued {Command.SpawnColonists(x, y, count)}";
    }

    private static string Give(string[] a, IDebugHost h)
    {
        int amount = Int(a[1]);
        var cmd = a[0].ToLowerInvariant() switch
        {
            "wood" => Command.AddStock(amount, 0),
            "food" => Command.AddStock(0, amount),
            _ => throw new FormatException(),
        };
        h.Sim.Enqueue(cmd);
        return $"queued {cmd}";
    }

    private static string Cold(string[] a, IDebugHost h)
    {
        var cmd = Command.SetClimateOffset(float.Parse(a[0], CultureInfo.InvariantCulture));
        h.Sim.Enqueue(cmd);
        return $"queued {cmd}";
    }

    private static string Speed(string[] a, IDebugHost h)
    {
        h.SetSpeed(Int(a[0]));
        return $"speed x{h.Speed}";
    }

    private static string Step(string[] a, IDebugHost h)
    {
        int ticks = a.Length > 0 ? Math.Clamp(Int(a[0]), 1, 100_000) : 1;
        h.StepTicks(ticks);
        return $"tick {h.Sim.Tick}";
    }

    private static string Goto(string[] a, IDebugHost h)
    {
        h.FocusTile(Int(a[0]), Int(a[1]));
        return "ok";
    }

    private static string PrintLog(string[] a, IDebugHost h)
    {
        var log = h.Sim.CommandLog;
        if (log.Count == 0) return "command log is empty";
        return string.Join("\n", log.TakeLast(50).Select(e => $"{e.Tick,8}  {e.Command}"))
               + (log.Count > 50 ? $"\n({log.Count - 50} older entries hidden)" : "");
    }

    private static string NewWorld(string[] a, IDebugHost h)
    {
        h.NewWorld(a.Length > 0 ? uint.Parse(a[0], CultureInfo.InvariantCulture) : null);
        return $"seed {h.Sim.Settings.Seed}";
    }

    private static string Retro(string[] a, IDebugHost h)
    {
        h.RetroFilter = a.Length == 0 ? !h.RetroFilter : a[0].Equals("on", StringComparison.OrdinalIgnoreCase);
        return $"retro filter {(h.RetroFilter ? "on" : "off")}";
    }

    private static string CameraMode(string[] a, IDebugHost h)
    {
        h.ObliqueCamera = a[0].ToLowerInvariant() switch
        {
            "oblique" or "ortho" => true,
            "perspective" or "persp" => false,
            _ => throw new FormatException(),
        };
        return $"camera {(h.ObliqueCamera ? "oblique" : "perspective")}";
    }

    private static int Int(string s) => int.Parse(s, CultureInfo.InvariantCulture);

    private static string Error(string message) => $"[color=#d0505a]{message}[/color]";
}
