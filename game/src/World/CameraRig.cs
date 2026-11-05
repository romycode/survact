using Godot;
using Survact.Game.Controls;

namespace Survact.Game.World;

/// <summary>
/// City-builder camera: a pivot on the ground with a Camera3D on a boom.
/// Pan (camera_* actions, relative to view yaw), rotate (camera_rotate_*), zoom (boom length),
/// drag (camera_drag). Narrow FOV for a diorama feel. Ground picking by ray/plane intersection.
/// </summary>
public partial class CameraRig : Node3D
{
    [Export] public float Pitch { get; set; } = 52f;          // degrees above the horizon
    [Export] public float Distance { get; set; } = 24f;
    [Export] public float MinDistance { get; set; } = 8f;
    [Export] public float MaxDistance { get; set; } = 110f;
    [Export] public float PanSpeed { get; set; } = 0.9f;       // fraction of boom length per second
    [Export] public float RotateSpeed { get; set; } = 90f;     // degrees per second
    [Export] public float ZoomStep { get; set; } = 1.12f;
    [Export] public float Smoothing { get; set; } = 12f;

    private Camera3D _camera = null!;
    private float _yaw;
    private float _distanceTarget;
    private bool _dragging;

    public Camera3D Camera => _camera;

    public override void _Ready()
    {
        _camera = GetNode<Camera3D>("Camera");
        _distanceTarget = Distance;
        _camera.MakeCurrent();
        UpdateBoom();
    }

    public override void _Process(double delta)
    {
        float dt = (float)delta;

        // Don't move while typing (debug console lives in the root viewport).
        if (GetTree().Root.GuiGetFocusOwner() is not LineEdit)
        {
            var dir = Input.GetVector(Actions.CameraLeft, Actions.CameraRight, Actions.CameraUp, Actions.CameraDown);
            if (dir != Vector2.Zero) Pan(dir * PanSpeed * Distance * dt);

            float rot = Input.GetAxis(Actions.CameraRotateLeft, Actions.CameraRotateRight);
            if (rot != 0) _yaw += Mathf.DegToRad(RotateSpeed) * rot * dt;
        }

        Distance = Mathf.Lerp(Distance, _distanceTarget, 1f - Mathf.Exp(-Smoothing * dt));
        UpdateBoom();
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        if (@event.IsActionPressed(Actions.CameraZoomIn)) _distanceTarget = Mathf.Max(MinDistance, _distanceTarget / ZoomStep);
        else if (@event.IsActionPressed(Actions.CameraZoomOut)) _distanceTarget = Mathf.Min(MaxDistance, _distanceTarget * ZoomStep);
        else if (@event.IsActionPressed(Actions.CameraDrag)) _dragging = true;
        else if (@event.IsActionReleased(Actions.CameraDrag)) _dragging = false;
        else if (@event is InputEventMouseMotion motion && _dragging)
        {
            float worldPerPixel = 2f * Distance * Mathf.Tan(Mathf.DegToRad(_camera.Fov) / 2f) / GetViewport().GetVisibleRect().Size.Y;
            Pan(-motion.Relative * worldPerPixel);
        }
        else return;

        GetViewport().SetInputAsHandled();
    }

    public void CenterOn(Vector3 groundPoint) => Position = new Vector3(groundPoint.X, 0, groundPoint.Z);

    /// <summary>Ground point under the mouse (y = 0 plane), if the ray hits it.</summary>
    public bool TryGetGroundUnderMouse(out Vector3 point)
    {
        var mouse = GetViewport().GetMousePosition();
        var origin = _camera.ProjectRayOrigin(mouse);
        var dir = _camera.ProjectRayNormal(mouse);
        point = default;
        if (Mathf.Abs(dir.Y) < 1e-4f) return false;
        float t = -origin.Y / dir.Y;
        if (t <= 0) return false;
        point = origin + dir * t;
        return true;
    }

    private void Pan(Vector2 screenDelta)
    {
        // Screen right/up mapped onto the ground, rotated by the current yaw.
        var right = new Vector3(Mathf.Cos(_yaw), 0, -Mathf.Sin(_yaw));
        var forward = new Vector3(-Mathf.Sin(_yaw), 0, -Mathf.Cos(_yaw));
        Position += right * screenDelta.X - forward * screenDelta.Y;
    }

    private void UpdateBoom()
    {
        float pitch = Mathf.DegToRad(Pitch);
        var offset = new Vector3(Mathf.Sin(_yaw), 0, Mathf.Cos(_yaw)) * Mathf.Cos(pitch) * Distance
                     + Vector3.Up * Mathf.Sin(pitch) * Distance;
        _camera.Position = offset;
        _camera.LookAt(GlobalPosition, Vector3.Up);
    }
}
