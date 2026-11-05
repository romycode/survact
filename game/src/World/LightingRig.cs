using Godot;

namespace Survact.Game.World;

/// <summary>
/// Time of day and cold, made visible: the sun crosses the sky with shadows, turns warm at dusk and
/// sets; a dim blue moon takes over; ambient, sky and fog follow. Also publishes the frost level as
/// the global shader uniform `survact_frost` (snow on ground and trees, frozen water).
/// Visual only: reads sim time/temperature, never writes to the sim.
/// </summary>
public partial class LightingRig : Node3D
{
    private static readonly StringName FrostGlobal = "survact_frost";

    [Export] public float MaxSunElevation { get; set; } = 62f;
    [Export] public float SunEnergy { get; set; } = 1.1f;
    [Export] public float MoonEnergy { get; set; } = 0.22f;

    private static readonly Color DaySky = new(0.66f, 0.74f, 0.83f);
    private static readonly Color NightSky = new(0.04f, 0.06f, 0.11f);
    private static readonly Color DayAmbient = new(0.56f, 0.62f, 0.74f);
    private static readonly Color NightAmbient = new(0.16f, 0.20f, 0.34f);
    private static readonly Color NoonSun = new(1.0f, 0.97f, 0.92f);
    private static readonly Color DuskSun = new(1.0f, 0.62f, 0.38f);

    private DirectionalLight3D _sun = null!;
    private DirectionalLight3D _moon = null!;
    private Godot.Environment _env = null!;

    public override void _Ready()
    {
        _sun = GetNode<DirectionalLight3D>("Sun");
        _moon = GetNode<DirectionalLight3D>("Moon");
        _env = GetNode<WorldEnvironment>("Environment").Environment;
    }

    /// <param name="timeOfDay">0..1, 0.5 = noon.</param>
    /// <param name="temperature">°C, drives frost and fog.</param>
    public void Apply(float timeOfDay, float temperature)
    {
        float height = Mathf.Sin(Mathf.Tau * (timeOfDay - 0.25f)); // -1 midnight .. 1 noon
        float day = Mathf.Clamp(height * 2.2f + 0.35f, 0f, 1f);

        // Sun: rises in the east (+X), crosses the south (+Z, behind the default camera), sets in
        // the west. A light shines along its -Z, so yaw = PI - tau*t gives exactly that path.
        float elevation = Mathf.DegToRad(Mathf.Max(4f, height * MaxSunElevation));
        float azimuth = Mathf.Pi - Mathf.Tau * timeOfDay;
        _sun.Rotation = new Vector3(-elevation, azimuth, 0);
        _sun.LightEnergy = SunEnergy * day;
        _sun.LightColor = DuskSun.Lerp(NoonSun, Mathf.Clamp(height * 2.5f, 0f, 1f));
        _sun.Visible = day > 0.01f;

        _moon.LightEnergy = MoonEnergy * (1f - day);
        _moon.Visible = day < 0.99f;

        float frost = Frost(temperature);
        var sky = NightSky.Lerp(DaySky, day);
        _env.BackgroundColor = sky;
        _env.FogLightColor = sky.Lerp(new Color(0.85f, 0.88f, 0.94f), frost * 0.5f * day);
        _env.FogDensity = 0.0025f + frost * 0.009f;
        _env.AmbientLightColor = NightAmbient.Lerp(DayAmbient, day);
        _env.AmbientLightEnergy = 0.32f + 0.22f * day;

        RenderingServer.GlobalShaderParameterSet(FrostGlobal, frost);
    }

    /// <summary>0 at +5°C and above, saturating around −29°C.</summary>
    public static float Frost(float temperature) => Mathf.Clamp((5f - temperature) / 40f, 0f, 0.85f);
}
