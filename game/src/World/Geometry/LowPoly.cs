using System.Numerics;

namespace Survact.Game.World.Geometry;

/// <summary>
/// Procedural low-poly models. 1 unit = 1 tile. Origin at the base centre, +Y up.
/// Placeholder art with a coherent style; swap for imported .glb models one at a time.
/// </summary>
public static class LowPoly
{
    // Tree: hexagonal trunk + two stacked cones. Foliage is snow-able (kind Foliage).
    public static MeshData Pine()
    {
        var m = new MeshData();
        var trunk = SurfaceKind.Rgb(0.36f, 0.25f, 0.17f, SurfaceKind.Plain);
        var leavesDark = SurfaceKind.Rgb(0.16f, 0.30f, 0.20f, SurfaceKind.Foliage);
        var leavesLight = SurfaceKind.Rgb(0.20f, 0.37f, 0.23f, SurfaceKind.Foliage);
        Prism(m, Vector3.Zero, radius: 0.07f, height: 0.32f, sides: 5, trunk);
        Cone(m, new Vector3(0, 0.22f, 0), radius: 0.40f, height: 0.62f, sides: 7, leavesDark);
        Cone(m, new Vector3(0, 0.58f, 0), radius: 0.29f, height: 0.52f, sides: 7, leavesLight);
        return m;
    }

    // Berry bush: squashed octahedron-ish blob with a couple of berry clusters.
    public static MeshData Bush()
    {
        var m = new MeshData();
        var leaves = SurfaceKind.Rgb(0.28f, 0.38f, 0.20f, SurfaceKind.Foliage);
        var berries = SurfaceKind.Rgb(0.70f, 0.14f, 0.22f, SurfaceKind.Plain);
        Blob(m, new Vector3(0, 0, 0), radius: 0.30f, height: 0.32f, sides: 6, leaves);
        Box(m, new Vector3(0.12f, 0.22f, 0.10f), new Vector3(0.07f), berries);
        Box(m, new Vector3(-0.10f, 0.18f, -0.08f), new Vector3(0.07f), berries);
        Box(m, new Vector3(-0.02f, 0.27f, 0.13f), new Vector3(0.06f), berries);
        return m;
    }

    // Colonist: blocky body + head. White so the per-instance color (job/state) shows as-is.
    public static MeshData Colonist()
    {
        var m = new MeshData();
        var body = SurfaceKind.Rgb(1f, 1f, 1f, SurfaceKind.Plain);
        var head = SurfaceKind.Rgb(0.95f, 0.86f, 0.74f, SurfaceKind.Plain);
        var dark = SurfaceKind.Rgb(0.25f, 0.24f, 0.26f, SurfaceKind.Plain);
        Box(m, new Vector3(-0.07f, 0.09f, 0), new Vector3(0.09f, 0.18f, 0.12f), dark);  // legs
        Box(m, new Vector3(0.07f, 0.09f, 0), new Vector3(0.09f, 0.18f, 0.12f), dark);
        Box(m, new Vector3(0, 0.33f, 0), new Vector3(0.30f, 0.30f, 0.20f), body);        // coat
        Box(m, new Vector3(0, 0.58f, 0), new Vector3(0.18f, 0.18f, 0.18f), head);
        Box(m, new Vector3(0, 0.69f, 0), new Vector3(0.21f, 0.06f, 0.21f), dark);        // hat
        return m;
    }

    // ---- primitives (centre-based, outward normals guaranteed) ---------------------------------

    public static void Box(MeshData m, Vector3 center, Vector3 size, Vector4 color)
    {
        var h = size / 2;
        Vector3 P(float x, float y, float z) => center + new Vector3(x * h.X, y * h.Y, z * h.Z);
        m.Quad(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1), Vector3.UnitY, color);
        m.Quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), -Vector3.UnitY, color);
        m.Quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), Vector3.UnitZ, color);
        m.Quad(P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), -Vector3.UnitZ, color);
        m.Quad(P(1, -1, -1), P(1, -1, 1), P(1, 1, 1), P(1, 1, -1), Vector3.UnitX, color);
        m.Quad(P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1), -Vector3.UnitX, color);
    }

    public static void Prism(MeshData m, Vector3 baseCenter, float radius, float height, int sides, Vector4 color)
    {
        var top = baseCenter + new Vector3(0, height, 0);
        for (int i = 0; i < sides; i++)
        {
            var a = Ring(baseCenter, radius, i, sides);
            var b = Ring(baseCenter, radius, i + 1, sides);
            var mid = (a + b) / 2 - baseCenter;
            m.Quad(a, b, b + (top - baseCenter), a + (top - baseCenter), new Vector3(mid.X, 0, mid.Z), color);
            m.Triangle(top, a + (top - baseCenter), b + (top - baseCenter), color, Vector3.UnitY);
        }
    }

    public static void Cone(MeshData m, Vector3 baseCenter, float radius, float height, int sides, Vector4 color)
    {
        var apex = baseCenter + new Vector3(0, height, 0);
        for (int i = 0; i < sides; i++)
        {
            var a = Ring(baseCenter, radius, i, sides);
            var b = Ring(baseCenter, radius, i + 1, sides);
            var outward = (a + b) / 2 - baseCenter;
            m.Triangle(a, b, apex, color, new Vector3(outward.X, radius / height * 0.5f, outward.Z));
            m.Triangle(baseCenter, b, a, color, -Vector3.UnitY);
        }
    }

    /// <summary>Two cones base to base, squashed: a cheap rounded blob.</summary>
    public static void Blob(MeshData m, Vector3 baseCenter, float radius, float height, int sides, Vector4 color)
    {
        var waist = baseCenter + new Vector3(0, height * 0.4f, 0);
        var top = baseCenter + new Vector3(0, height, 0);
        for (int i = 0; i < sides; i++)
        {
            var a = Ring(waist, radius, i, sides);
            var b = Ring(waist, radius, i + 1, sides);
            var outward = (a + b) / 2 - waist;
            m.Triangle(a, b, top, color, new Vector3(outward.X, 0.6f, outward.Z));
            m.Triangle(a, b, baseCenter, color, new Vector3(outward.X, -0.6f, outward.Z));
        }
    }

    private static Vector3 Ring(Vector3 center, float radius, int i, int sides)
    {
        float a = MathF.Tau * i / sides;
        return center + new Vector3(MathF.Cos(a) * radius, 0, MathF.Sin(a) * radius);
    }
}
