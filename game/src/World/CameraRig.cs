using Godot;
using Survact.Game.Controls;

namespace Survact.Game.World;

/// <summary>Pan with camera_* actions (keys or gamepad), zoom toward the cursor, drag with camera_drag.</summary>
public partial class CameraRig : Camera2D
{
    [Export] public float PanSpeed { get; set; } = 900f;
    [Export] public float MinZoom { get; set; } = 0.25f;
    [Export] public float MaxZoom { get; set; } = 6f;
    [Export] public float ZoomStep { get; set; } = 1.15f;

    private bool _dragging;

    public override void _Ready()
    {
        Zoom = new Vector2(2f, 2f);
        MakeCurrent();
    }

    public override void _Process(double delta)
    {
        // Don't move while typing in a text field (debug console, future chat/rename boxes).
        if (GetViewport().GuiGetFocusOwner() is LineEdit) return;

        var dir = Input.GetVector(Actions.CameraLeft, Actions.CameraRight, Actions.CameraUp, Actions.CameraDown);
        if (dir != Vector2.Zero) Position += dir * PanSpeed * (float)delta / Zoom.X;
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        if (@event.IsActionPressed(Actions.CameraZoomIn)) ZoomAtCursor(ZoomStep);
        else if (@event.IsActionPressed(Actions.CameraZoomOut)) ZoomAtCursor(1f / ZoomStep);
        else if (@event.IsActionPressed(Actions.CameraDrag)) _dragging = true;
        else if (@event.IsActionReleased(Actions.CameraDrag)) _dragging = false;
        else if (@event is InputEventMouseMotion motion && _dragging) Position -= motion.Relative / Zoom.X;
        else return;

        GetViewport().SetInputAsHandled();
    }

    public void CenterOn(Vector2 worldPosition) => Position = worldPosition;

    private void ZoomAtCursor(float factor)
    {
        var before = GetGlobalMousePosition();
        float z = Mathf.Clamp(Zoom.X * factor, MinZoom, MaxZoom);
        Zoom = new Vector2(z, z);
        ForceUpdateScroll();
        Position += before - GetGlobalMousePosition();
    }
}
