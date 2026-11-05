using System.Diagnostics;
using Survact.Sim;
using Survact.Sim.Persistence;
using Godot;

namespace Survact.Game;

/// <summary>
/// Owns the simulation and drives it with a fixed timestep. Everything Godot does here is
/// presentation: renderers read sim state, input becomes sim commands (later), nothing more.
/// </summary>
public partial class Main : Node2D
{
    public const int TilePx = 8;

    private const double TickDt = 1.0 / Simulation.TicksPerSecond;
    private const int MaxStepsPerFrame = 16;
    private static readonly int[] Speeds = [1, 3, 10];
    private static readonly string SavePath = "user://save.survact";

    private Simulation _sim = null!;
    private double _accumulator;
    private int _speedIndex;
    private bool _paused;

    private readonly SystemProfiler _profiler = new();
    private double _simMsWindow;
    private int _simStepsWindow;
    private double _windowTime;
    private double _simMsPerTick;

    private TerrainRenderer _terrain = null!;
    private ColonistRenderer _colonists = null!;
    private Overlay _overlay = null!;
    private CanvasModulate _daylight = null!;
    private CameraRig _camera = null!;
    private Hud _hud = null!;

    public override void _Ready()
    {
        _terrain = new TerrainRenderer { Name = "Terrain" };
        _overlay = new Overlay { Name = "Overlay", ZIndex = 1 };
        _colonists = new ColonistRenderer { Name = "Colonists", ZIndex = 2 };
        _daylight = new CanvasModulate { Name = "Daylight" };
        _camera = new CameraRig { Name = "Camera" };
        _hud = new Hud { Name = "Hud" };

        AddChild(_terrain);
        AddChild(_overlay);
        AddChild(_colonists);
        AddChild(_daylight);
        AddChild(_camera);
        AddChild(_hud);

        StartWorld(Simulation.Create(new SimSettings(Seed: 1337, InitialColonists: 30)));
    }

    private void StartWorld(Simulation sim)
    {
        _sim = sim;
        _sim.Profiler = _profiler;
        _accumulator = 0;

        _terrain.Bind(sim);
        _colonists.Bind(sim);
        _overlay.Bind(sim);
        _camera.Position = new Vector2(sim.Colony.StockX + 0.5f, sim.Colony.StockY + 0.5f) * TilePx;
    }

    public override void _Process(double delta)
    {
        if (!_paused) Advance(delta);

        float alpha = _paused ? 1f : (float)(_accumulator / TickDt);
        _terrain.Sync();
        _colonists.Sync(alpha);
        _overlay.Sync();
        _daylight.Color = Daylight(_sim.TimeOfDay);

        _windowTime += delta;
        if (_windowTime >= 0.5)
        {
            _simMsPerTick = _simStepsWindow == 0 ? 0 : _simMsWindow / _simStepsWindow;
            _simMsWindow = 0;
            _simStepsWindow = 0;
            _windowTime = 0;
            _hud.Refresh(_sim, Speeds[_speedIndex], _paused, _simMsPerTick, Engine.GetFramesPerSecond(), _profiler);
            _profiler.Reset();
        }
    }

    private void Advance(double delta)
    {
        _accumulator += delta * Speeds[_speedIndex];
        int steps = 0;
        while (_accumulator >= TickDt && steps < MaxStepsPerFrame)
        {
            long start = Stopwatch.GetTimestamp();
            _sim.Step();
            _simMsWindow += Stopwatch.GetElapsedTime(start).TotalMilliseconds;
            _simStepsWindow++;
            _accumulator -= TickDt;
            steps++;
        }

        // Can't keep up (debugger pause, huge hitch, too fast a speed): drop the debt instead of spiralling.
        if (steps == MaxStepsPerFrame && _accumulator > TickDt) _accumulator = 0;
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        if (@event is not InputEventKey { Pressed: true, Echo: false } key) return;

        switch (key.Keycode)
        {
            case Key.Space: _paused = !_paused; break;
            case Key.Key1: _speedIndex = 0; break;
            case Key.Key2: _speedIndex = 1; break;
            case Key.Key3: _speedIndex = 2; break;
            case Key.F5: Save(); break;
            case Key.F9: Load(); break;
            case Key.N:
                StartWorld(Simulation.Create(new SimSettings(Seed: (uint)Time.GetTicksUsec(), InitialColonists: 30)));
                break;
            default: return;
        }
        GetViewport().SetInputAsHandled();
    }

    private void Save()
    {
        using var file = System.IO.File.Create(ProjectSettings.GlobalizePath(SavePath));
        SaveGame.Save(_sim, file);
        _hud.Flash("Saved");
    }

    private void Load()
    {
        string path = ProjectSettings.GlobalizePath(SavePath);
        if (!System.IO.File.Exists(path))
        {
            _hud.Flash("No save yet (F5)");
            return;
        }
        using var file = System.IO.File.OpenRead(path);
        StartWorld(SaveGame.Load(file));
        _hud.Flash("Loaded");
    }

    /// <summary>Cheap day/night: tint the whole world canvas. The HUD lives on its own layer and isn't affected.</summary>
    private static Color Daylight(float timeOfDay)
    {
        float sun = Mathf.Clamp(Mathf.Sin(Mathf.Tau * (timeOfDay - 0.25f)) * 1.6f + 0.5f, 0f, 1f);
        var night = new Color(0.32f, 0.36f, 0.55f);
        return night.Lerp(Colors.White, sun);
    }
}
