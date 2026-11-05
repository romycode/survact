using Godot;
using Survact.Game.Controls;

namespace Survact.Game.World;

/// <summary>
/// Strategy camera: a pivot on the ground with a Camera3D on a boom. Two modes:
///  - Perspective (default): the ground recedes and converges toward the horizon, which is what
///    makes a 3D world read as a floor and not as a wall climbing up the screen. Q/E orbit.
///  - Oblique: Factorio-like orthographic view (no perspective, grid-aligned, Q/E in 90° steps).
///    Great for dense building, but with real relief the missing depth cues make the ground look
///    tilted up toward the sky.
/// Pan relative to the view, zoom, drag. Picking ray-marches the real terrain heights.
/// </summary>
public partial class CameraRig : Node3D
{
    public enum ViewMode { Oblique, Perspective }

    [Export] public ViewMode Mode { get; set; } = ViewMode.Perspective;

    [ExportGroup("Oblique")]
    [Export] public float ObliquePitch { get; set; } = 40f;    // degrees above the horizon: lower = more side faces, more 3D
    [Export] public float ViewHeight { get; set; } = 20f;      // world units visible vertically
    [Export] public float MinViewHeight { get; set; } = 8f;
    [Export] public float MaxViewHeight { get; set; } = 90f;

    [ExportGroup("Perspective")]
    [Export] public float Pitch { get; set; } = 42f;
    [Export] public float Distance { get; set; } = 30f;
    [Export] public float MinDistance { get; set; } = 8f;
    [Export] public float MaxDistance { get; set; } = 110f;
    [Export] public float RotateSpeed { get; set; } = 90f;     // degrees per second

    [ExportGroup("Common")]
    [Export] public float PanSpeed { get; set; } = 0.9f;       // fraction of the view per second
    [Export] public float ZoomStep { get; set; } = 1.12f;
    [Export] public float Smoothing { get; set; } = 12f;

    /// <summary>Terrain top height at a world (x, z). Set by the game; used for picking and pivot height.</summary>
    public Func<float, float, float>? GroundHeight { get; set; }

    private const float ObliqueBoom = 80f; // far enough that tall terrain never clips the near plane

    private Camera3D _camera = null!;
    private float _yaw, _yawTarget;
    private float _zoom, _zoomTarget; // ViewHeight (oblique) or Distance (perspective)
    private bool _dragging;

    public override void _Ready()
    {
        _camera = GetNode<Camera3D>("Camera");
        _camera.MakeCurrent();
        ApplyMode();
        UpdateBoom();
    }

    public void SetMode(ViewMode mode)
    {
        Mode = mode;
        ApplyMode();
        ModeChanged?.Invoke(mode);
    }

    /// <summary>Raised when the projection changes (lighting adapts fog to it).</summary>
    public event Action<ViewMode>? ModeChanged;

    public override void _Process(double delta)
    {
        float dt = (float)delta;
        float ease = 1f - Mathf.Exp(-Smoothing * dt);

        if (GetTree().Root.GuiGetFocusOwner() is not LineEdit)
        {
            var dir = Input.GetVector(Actions.CameraLeft, Actions.CameraRight, Actions.CameraUp, Actions.CameraDown);
            if (dir != Vector2.Zero) Pan(dir * PanSpeed * VisibleSpan() * dt);

            if (Mode == ViewMode.Perspective)
            {
                float rot = Input.GetAxis(Actions.CameraRotateLeft, Actions.CameraRotateRight);
                _yawTarget += Mathf.DegToRad(RotateSpeed) * rot * dt;
            }
        }

        _yaw = Mathf.LerpAngle(_yaw, _yawTarget, ease);
        _zoom = Mathf.Lerp(_zoom, _zoomTarget, ease);

        // Keep the pivot on the terrain so zoom and rotation centre on what you're looking at.
        if (GroundHeight is { } ground)
            Position = Position with { Y = Mathf.Lerp(Position.Y, ground(Position.X, Position.Z), ease) };

        UpdateBoom();
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        if (@event.IsActionPressed(Actions.CameraZoomIn)) _zoomTarget = Mathf.Max(MinZoom, _zoomTarget / ZoomStep);
        else if (@event.IsActionPressed(Actions.CameraZoomOut)) _zoomTarget = Mathf.Min(MaxZoom, _zoomTarget * ZoomStep);
        else if (Mode == ViewMode.Oblique && @event.IsActionPressed(Actions.CameraRotateLeft)) _yawTarget -= Mathf.Pi / 2;
        else if (Mode == ViewMode.Oblique && @event.IsActionPressed(Actions.CameraRotateRight)) _yawTarget += Mathf.Pi / 2;
        else if (@event.IsActionPressed(Actions.CameraDrag)) _dragging = true;
        else if (@event.IsActionReleased(Actions.CameraDrag)) _dragging = false;
        else if (@event is InputEventMouseMotion motion && _dragging)
            Pan(-motion.Relative * VisibleSpan() / GetViewport().GetVisibleRect().Size.Y);
        else return;

        GetViewport().SetInputAsHandled();
    }

    public void CenterOn(Vector3 groundPoint) => Position = groundPoint;

    /// <summary>Terrain point under the mouse: ray-marches the heightfield, refines by bisection.</summary>
    public bool TryGetGroundUnderMouse(out Vector3 point)
    {
        var mouse = GetViewport().GetMousePosition();
        var origin = _camera.ProjectRayOrigin(mouse);
        var dir = _camera.ProjectRayNormal(mouse);
        point = default;

        if (GroundHeight is not { } ground)
        {
            if (Mathf.Abs(dir.Y) < 1e-4f) return false;
            float t0 = -origin.Y / dir.Y;
            if (t0 <= 0) return false;
            point = origin + dir * t0;
            return true;
        }

        const float step = 0.25f;
        float prev = 0;
        for (float t = 0; t < 600f; t += step)
        {
            var p = origin + dir * t;
            if (p.Y > ground(p.X, p.Z)) { prev = t; continue; }

            float lo = prev, hi = t;
            for (int i = 0; i < 8; i++)
            {
                float mid = (lo + hi) / 2;
                var q = origin + dir * mid;
                if (q.Y > ground(q.X, q.Z)) lo = mid; else hi = mid;
            }
            point = origin + dir * hi;
            return true;
        }
        return false;
    }

    private float MinZoom => Mode == ViewMode.Oblique ? MinViewHeight : MinDistance;
    private float MaxZoom => Mode == ViewMode.Oblique ? MaxViewHeight : MaxDistance;

    /// <summary>World units spanned by the screen height at the pivot: makes pan/drag speed zoom-independent.</summary>
    private float VisibleSpan() => Mode == ViewMode.Oblique
        ? _zoom
        : 2f * _zoom * Mathf.Tan(Mathf.DegToRad(_camera.Fov) / 2f);

    private void ApplyMode()
    {
        if (Mode == ViewMode.Oblique)
        {
            _camera.Projection = Camera3D.ProjectionType.Orthogonal;
            _zoom = _zoomTarget = ViewHeight;
            _yawTarget = Mathf.Round(_yawTarget / (Mathf.Pi / 2)) * (Mathf.Pi / 2); // snap to a grid-aligned view
        }
        else
        {
            _camera.Projection = Camera3D.ProjectionType.Perspective;
            _zoom = _zoomTarget = Distance;
        }
    }

    private void Pan(Vector2 screenDelta)
    {
        // Screen right/up mapped onto the ground, rotated by the current yaw.
        var right = new Vector3(Mathf.Cos(_yaw), 0, -Mathf.Sin(_yaw));
        var forward = new Vector3(-Mathf.Sin(_yaw), 0, -Mathf.Cos(_yaw));
        float verticalScale = Mode == ViewMode.Oblique ? 1f / Mathf.Sin(Mathf.DegToRad(ObliquePitch)) : 1f;
        Position += right * screenDelta.X - forward * screenDelta.Y * verticalScale;
    }

    private void UpdateBoom()
    {
        bool oblique = Mode == ViewMode.Oblique;
        float pitch = Mathf.DegToRad(oblique ? ObliquePitch : Pitch);
        float boom = oblique ? ObliqueBoom : _zoom;
        if (oblique) _camera.Size = _zoom;

        var offset = new Vector3(Mathf.Sin(_yaw), 0, Mathf.Cos(_yaw)) * Mathf.Cos(pitch) * boom
                     + Vector3.Up * Mathf.Sin(pitch) * boom;
        _camera.Position = offset;
        _camera.LookAt(GlobalPosition, Vector3.Up);
    }
}
