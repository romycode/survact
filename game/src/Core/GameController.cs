using System.Diagnostics;
using Godot;
using Survact.Game.Controls;
using Survact.Game.Debug;
using Survact.Game.UI;
using Survact.Game.World;
using Survact.Sim;
using Survact.Sim.Commands;
using Survact.Sim.Data;
using Survact.Sim.Persistence;

namespace Survact.Game.Core;

/// <summary>
/// Root of Main.tscn. Owns the simulation and drives it with a fixed timestep.
/// Godot idiom "call down, signal up": this node calls methods on its children; children
/// (console, future UI panels) report back through signals wired in the scene.
/// Player intent reaches the simulation only as Commands (see Sim.Commands).
/// </summary>
public partial class GameController : Node, IDebugHost
{
    private const double TickDt = 1.0 / Simulation.TicksPerSecond;
    private const int MaxStepsPerFrame = 16;
    private const string SavePath = "user://quicksave.survact";
    private static readonly int[] Speeds = [1, 3, 10];

    [Export] public uint StartSeed { get; set; } = 1337;
    [Export] public int StartColonists { get; set; } = 30;
    [Export] public int MapSize { get; set; } = 256;

    public Simulation Sim { get; private set; } = null!;
    public GameData Data { get; private set; } = null!;
    public bool Paused { get; private set; }
    public int Speed => Speeds[_speedIndex];
    public SystemProfiler Profiler { get; } = new();

    private int _speedIndex;
    private double _accumulator;
    private double _simMsWindow;
    private int _simStepsWindow;
    private double _windowTime;
    private double _simMsPerTick;

    private Node2D _world = null!;
    private TerrainRenderer _terrain = null!;
    private ColonistRenderer _colonists = null!;
    private Overlay _overlay = null!;
    private CanvasModulate _daylight = null!;
    private CameraRig _camera = null!;
    private Hud _hud = null!;
    private DebugConsole _console = null!;
    private DebugOverlay _debugOverlay = null!;

    public override void _EnterTree()
    {
        // Before any child's _Ready: UI reads bindings to show key labels.
        InputBindings.InstallDefaults();
    }

    public override void _Ready()
    {
        _world = GetNode<Node2D>("%World");
        _terrain = GetNode<TerrainRenderer>("%Terrain");
        _colonists = GetNode<ColonistRenderer>("%Colonists");
        _overlay = GetNode<Overlay>("%Overlay");
        _daylight = GetNode<CanvasModulate>("%Daylight");
        _camera = GetNode<CameraRig>("%Camera");
        _hud = GetNode<Hud>("%Hud");
        _console = GetNode<DebugConsole>("%DebugConsole");
        _debugOverlay = GetNode<DebugOverlay>("%DebugOverlay");

        try
        {
            Data = GameDataLoader.Load();
        }
        catch (GameDataException e)
        {
            // Fail loud: running with broken data only hides the problem.
            GD.PushError(e.Message);
            OS.Alert(e.Message, "Survact: invalid game data");
            GetTree().Quit(1);
            return;
        }

        StartWorld(Simulation.Create(new SimSettings(StartSeed, MapSize, MapSize, StartColonists), Data));
    }

    public override void _Process(double delta)
    {
        if (Sim is null) return;
        if (!Paused) Advance(delta);

        float alpha = Paused ? 1f : (float)(_accumulator / TickDt);
        _terrain.Sync();
        _colonists.Sync(alpha);
        _overlay.Sync();
        _daylight.Color = Daylight(Sim.TimeOfDay);

        _windowTime += delta;
        if (_windowTime < 0.25) return;

        _simMsPerTick = _simStepsWindow == 0 ? _simMsPerTick : _simMsWindow / _simStepsWindow;
        _simMsWindow = 0;
        _simStepsWindow = 0;
        _windowTime = 0;
        _hud.Refresh(Sim, Speed, Paused, _simMsPerTick, Engine.GetFramesPerSecond());
        if (_debugOverlay.Visible) _debugOverlay.Refresh(Sim, HoveredTile(), Profiler, _simMsPerTick);
        Profiler.Reset();
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        if (@event.IsActionPressed(Actions.Pause)) TogglePause();
        else if (@event.IsActionPressed(Actions.Speed1)) SetSpeed(Speeds[0]);
        else if (@event.IsActionPressed(Actions.Speed2)) SetSpeed(Speeds[1]);
        else if (@event.IsActionPressed(Actions.Speed3)) SetSpeed(Speeds[2]);
        else if (@event.IsActionPressed(Actions.QuickSave)) QuickSave();
        else if (@event.IsActionPressed(Actions.QuickLoad)) QuickLoad();
        else if (@event.IsActionPressed(Actions.NewWorld)) NewWorld(null);
        else if (@event.IsActionPressed(Actions.DebugOverlay)) ToggleDebugOverlay();
        else return;

        GetViewport().SetInputAsHandled();
    }

    // ---- Signal handlers (wired in Main.tscn) -------------------------------------------------

    public void OnConsoleCommandSubmitted(string line) => _console.Print(DebugCommands.Execute(line, this));

    // ---- Game operations (also used by the debug console through IDebugHost) ------------------

    public void SetSpeed(int multiplier)
    {
        int index = Array.IndexOf(Speeds, multiplier);
        if (index >= 0) _speedIndex = index;
    }

    public void TogglePause() => Paused = !Paused;

    public void StepTicks(int ticks)
    {
        for (int i = 0; i < ticks; i++) Sim.Step();
        _accumulator = 0;
    }

    public void NewWorld(uint? seed)
    {
        uint s = seed ?? (uint)Time.GetTicksUsec();
        StartWorld(Simulation.Create(new SimSettings(s, MapSize, MapSize, StartColonists), Data));
        _hud.Notify(Tr("New world"));
    }

    public void QuickSave()
    {
        using var file = System.IO.File.Create(ProjectSettings.GlobalizePath(SavePath));
        SaveGame.Save(Sim, file);
        _hud.Notify(Tr("Game saved"));
    }

    public bool QuickLoad()
    {
        string path = ProjectSettings.GlobalizePath(SavePath);
        if (!System.IO.File.Exists(path))
        {
            _hud.Notify(Tr("No saved game yet"));
            return false;
        }

        try
        {
            using var file = System.IO.File.OpenRead(path);
            StartWorld(SaveGame.Load(file, Data));
        }
        catch (InvalidDataException e)
        {
            GD.PushWarning($"Quickload failed: {e.Message}");
            _hud.Notify(Tr("The saved game is not compatible with this version"));
            return false;
        }

        _hud.Notify(Tr("Game loaded"));
        return true;
    }

    public void ToggleDebugOverlay() => _debugOverlay.Visible = !_debugOverlay.Visible;

    public void ClearConsole() => _console.ClearLog();

    public void FocusTile(int x, int y) =>
        _camera.CenterOn(new Vector2(x + 0.5f, y + 0.5f) * RenderConfig.TilePx);

    // ---- Internals ------------------------------------------------------------------------------

    private void StartWorld(Simulation sim)
    {
        if (Sim is not null) Sim.CommandRejected -= OnCommandRejected;

        Sim = sim;
        Sim.Profiler = Profiler;
        Sim.CommandRejected += OnCommandRejected;
        _accumulator = 0;

        _terrain.Bind(sim);
        _colonists.Bind(sim);
        _overlay.Bind(sim);
        FocusTile(sim.Colony.StockX, sim.Colony.StockY);
    }

    private void OnCommandRejected(Command command, string reason) =>
        _console.Print($"[color=#e8833a]rejected {command}: {reason}[/color]");

    private void Advance(double delta)
    {
        _accumulator += delta * Speed;
        int steps = 0;
        while (_accumulator >= TickDt && steps < MaxStepsPerFrame)
        {
            long start = Stopwatch.GetTimestamp();
            Sim.Step();
            _simMsWindow += Stopwatch.GetElapsedTime(start).TotalMilliseconds;
            _simStepsWindow++;
            _accumulator -= TickDt;
            steps++;
        }

        // Can't keep up (debugger pause, hitch, too high a speed): drop the debt instead of spiralling.
        if (steps == MaxStepsPerFrame && _accumulator > TickDt) _accumulator = 0;
    }

    private Vector2I? HoveredTile()
    {
        var p = _world.GetGlobalMousePosition() / RenderConfig.TilePx;
        int x = Mathf.FloorToInt(p.X), y = Mathf.FloorToInt(p.Y);
        return Sim.Map.InBounds(x, y) ? new Vector2I(x, y) : null;
    }

    /// <summary>Cheap day/night: tint the world canvas. UI lives on its own CanvasLayers and isn't affected.</summary>
    private static Color Daylight(float timeOfDay)
    {
        float sun = Mathf.Clamp(Mathf.Sin(Mathf.Tau * (timeOfDay - 0.25f)) * 1.6f + 0.5f, 0f, 1f);
        var night = new Color(0.32f, 0.36f, 0.55f);
        return night.Lerp(Colors.White, sun);
    }
}
