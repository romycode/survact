using Godot;

namespace Survact.Game;

/// <summary>WASD/arrows to pan, wheel to zoom toward the cursor, middle mouse to drag.</summary>
public partial class CameraRig : Camera2D
{
    private const float PanSpeed = 900f;
    private const float MinZoom = 0.25f;
    private const float MaxZoom = 6f;

    private bool _dragging;

    public override void _Ready()
    {
        Zoom = new Vector2(2f, 2f);
        MakeCurrent();
    }

    public override void _Process(double delta)
    {
        var dir = Vector2.Zero;
        if (Input.IsKeyPressed(Key.A) || Input.IsKeyPressed(Key.Left)) dir.X -= 1;
        if (Input.IsKeyPressed(Key.D) || Input.IsKeyPressed(Key.Right)) dir.X += 1;
        if (Input.IsKeyPressed(Key.W) || Input.IsKeyPressed(Key.Up)) dir.Y -= 1;
        if (Input.IsKeyPressed(Key.S) || Input.IsKeyPressed(Key.Down)) dir.Y += 1;
        if (dir != Vector2.Zero) Position += dir.Normalized() * PanSpeed * (float)delta / Zoom.X;
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        switch (@event)
        {
            case InputEventMouseButton { ButtonIndex: MouseButton.WheelUp, Pressed: true }:
                ZoomAtCursor(1.15f);
                break;
            case InputEventMouseButton { ButtonIndex: MouseButton.WheelDown, Pressed: true }:
                ZoomAtCursor(1f / 1.15f);
                break;
            case InputEventMouseButton { ButtonIndex: MouseButton.Middle } mb:
                _dragging = mb.Pressed;
                break;
            case InputEventMouseMotion motion when _dragging:
                Position -= motion.Relative / Zoom.X;
                break;
            default:
                return;
        }
        GetViewport().SetInputAsHandled();
    }

    private void ZoomAtCursor(float factor)
    {
        var before = GetGlobalMousePosition();
        float z = Mathf.Clamp(Zoom.X * factor, MinZoom, MaxZoom);
        Zoom = new Vector2(z, z);
        ForceUpdateScroll();
        Position += before - GetGlobalMousePosition();
    }
}
