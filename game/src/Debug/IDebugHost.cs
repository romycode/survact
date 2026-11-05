using Survact.Sim;

namespace Survact.Game.Debug;

/// <summary>What debug commands may do to the running game. Keeps commands testable and decoupled from scenes.</summary>
public interface IDebugHost
{
    Simulation Sim { get; }
    bool Paused { get; }
    int Speed { get; }

    void SetSpeed(int multiplier);
    void TogglePause();
    void StepTicks(int ticks);
    void NewWorld(uint? seed);
    void QuickSave();
    bool QuickLoad();
    void ToggleDebugOverlay();
    void ClearConsole();
    void FocusTile(int x, int y);

    /// <summary>Low-res render factor of the retro view (1 = native resolution).</summary>
    int PixelScale { get; set; }
    bool RetroFilter { get; set; }

    /// <summary>true = oblique orthographic (Factorio-like), false = free perspective orbit.</summary>
    bool ObliqueCamera { get; set; }
}
