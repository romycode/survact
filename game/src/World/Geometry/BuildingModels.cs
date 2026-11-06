namespace Survact.Game.World.Geometry;

/// <summary>
/// Building type name (from game data) → model. Unknown types get a placeholder box so new data
/// entries show up immediately, before their art exists.
/// </summary>
public static class BuildingModels
{
    public static MeshData For(string name, int width, int height) => name switch
    {
        "tent" => LowPoly.Tent(),
        "cabin" => LowPoly.Cabin(),
        _ => Placeholder(width, height),
    };

    /// <summary>Lit-window overlay for types that have one (shown at night when occupied).</summary>
    public static MeshData? WindowFor(string name) => name switch
    {
        "cabin" => LowPoly.CabinWindow(),
        _ => null,
    };

    private static MeshData Placeholder(int w, int h)
    {
        var m = new MeshData();
        LowPoly.Box(m, new System.Numerics.Vector3(w / 2f, 0.5f, h / 2f), new System.Numerics.Vector3(w - 0.2f, 1f, h - 0.2f),
                    SurfaceKind.Rgb(0.8f, 0.3f, 0.8f, SurfaceKind.Plain));
        return m;
    }
}
