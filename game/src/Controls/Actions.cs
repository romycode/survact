using Godot;

namespace Survact.Game.Controls;

/// <summary>
/// Every input action the game knows, by name. Code never asks "is W pressed?", only
/// "is camera_up pressed?": bindings can change (rebinding menu, gamepad, other layouts)
/// without touching gameplay code. StringName instances are cached to avoid per-frame allocs.
/// </summary>
public static class Actions
{
    public static readonly StringName CameraLeft = "camera_left";
    public static readonly StringName CameraRight = "camera_right";
    public static readonly StringName CameraUp = "camera_up";
    public static readonly StringName CameraDown = "camera_down";
    public static readonly StringName CameraZoomIn = "camera_zoom_in";
    public static readonly StringName CameraZoomOut = "camera_zoom_out";
    public static readonly StringName CameraDrag = "camera_drag";
    public static readonly StringName CameraRotateLeft = "camera_rotate_left";
    public static readonly StringName CameraRotateRight = "camera_rotate_right";

    public static readonly StringName Pause = "game_pause";
    public static readonly StringName Speed1 = "game_speed_1";
    public static readonly StringName Speed2 = "game_speed_2";
    public static readonly StringName Speed3 = "game_speed_3";
    public static readonly StringName QuickSave = "game_quick_save";
    public static readonly StringName QuickLoad = "game_quick_load";
    public static readonly StringName NewWorld = "game_new_world";

    public static readonly StringName DebugConsole = "debug_console";
    public static readonly StringName DebugOverlay = "debug_overlay";
}
