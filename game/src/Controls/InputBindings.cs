using Godot;

namespace Survact.Game.Controls;

/// <summary>
/// Default bindings, installed at startup. Keyboard bindings use PHYSICAL keycodes: the key in the
/// WASD position is used on QWERTY, AZERTY or a Spanish layout alike. An action already configured
/// in Project Settings → Input Map keeps its configuration (editor wins over code defaults).
/// Next step: persist player overrides to user://input.cfg from a rebinding menu.
/// </summary>
public static class InputBindings
{
    private static readonly (StringName Action, InputEvent[] Events)[] Defaults =
    [
        (Actions.CameraLeft, [Key(global::Godot.Key.A), Key(global::Godot.Key.Left)]),
        (Actions.CameraRight, [Key(global::Godot.Key.D), Key(global::Godot.Key.Right)]),
        (Actions.CameraUp, [Key(global::Godot.Key.W), Key(global::Godot.Key.Up)]),
        (Actions.CameraDown, [Key(global::Godot.Key.S), Key(global::Godot.Key.Down)]),
        (Actions.CameraZoomIn, [Mouse(MouseButton.WheelUp), Key(global::Godot.Key.Equal)]),
        (Actions.CameraZoomOut, [Mouse(MouseButton.WheelDown), Key(global::Godot.Key.Minus)]),
        (Actions.CameraDrag, [Mouse(MouseButton.Middle)]),

        (Actions.Pause, [Key(global::Godot.Key.Space)]),
        (Actions.Speed1, [Key(global::Godot.Key.Key1)]),
        (Actions.Speed2, [Key(global::Godot.Key.Key2)]),
        (Actions.Speed3, [Key(global::Godot.Key.Key3)]),
        (Actions.QuickSave, [Key(global::Godot.Key.F5)]),
        (Actions.QuickLoad, [Key(global::Godot.Key.F9)]),
        (Actions.NewWorld, [Key(global::Godot.Key.N, ctrl: true)]),

        // QuoteLeft = the key left of "1" on every layout (` on US, º on Spanish).
        (Actions.DebugConsole, [Key(global::Godot.Key.Quoteleft), Key(global::Godot.Key.F1)]),
        (Actions.DebugOverlay, [Key(global::Godot.Key.F3)]),
    ];

    public static void InstallDefaults()
    {
        foreach (var (action, events) in Defaults)
        {
            if (!InputMap.HasAction(action)) InputMap.AddAction(action);
            if (InputMap.ActionGetEvents(action).Count > 0) continue; // configured in the editor
            foreach (var ev in events) InputMap.ActionAddEvent(action, ev);
        }
    }

    /// <summary>Human label of the first binding of an action, in the player's keyboard layout ("W", "F5", "Ctrl+N").</summary>
    public static string LabelOf(StringName action)
    {
        var events = InputMap.ActionGetEvents(action);
        if (events.Count == 0) return "—";
        return events[0] switch
        {
            InputEventKey k => KeyLabel(k),
            InputEventMouseButton { ButtonIndex: MouseButton.WheelUp or MouseButton.WheelDown } => "Wheel",
            var other => other.AsText(),
        };
    }

    private static string KeyLabel(InputEventKey k)
    {
        var keycode = k.PhysicalKeycode != global::Godot.Key.None
            ? DisplayServer.KeyboardGetKeycodeFromPhysical(k.PhysicalKeycode)
            : k.Keycode;
        string name = OS.GetKeycodeString(keycode);
        return k.CtrlPressed ? $"Ctrl+{name}" : name;
    }

    private static InputEventKey Key(Key physical, bool ctrl = false) =>
        new() { PhysicalKeycode = physical, CtrlPressed = ctrl };

    private static InputEventMouseButton Mouse(MouseButton button) => new() { ButtonIndex = button };
}
