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

    // Boulder: lumpy low-poly rock. Upward faces collect snow (kind Foliage) in the cold.
    public static MeshData Boulder()
    {
        var m = new MeshData();
        var stone = SurfaceKind.Rgb(0.47f, 0.46f, 0.47f, SurfaceKind.Foliage);
        const int sides = 7;
        // Rings (height, radius); per-vertex radial jitter makes it irregular but deterministic.
        (float Y, float R)[] rings = [(-0.05f, 0.40f), (0.22f, 0.46f), (0.48f, 0.32f)];
        var top = new Vector3(0.03f, 0.62f, -0.02f);
        var bottom = new Vector3(0, -0.05f, 0);
        Vector3 V(int ring, int i)
        {
            float a = MathF.Tau * i / sides + ring * 0.4f;
            float jitter = 0.78f + 0.44f * Fract(MathF.Sin(ring * 12.9898f + i * 78.233f) * 43758.547f);
            return new Vector3(MathF.Cos(a) * rings[ring].R * jitter, rings[ring].Y, MathF.Sin(a) * rings[ring].R * jitter);
        }
        for (int i = 0; i < sides; i++)
        {
            for (int r = 0; r < rings.Length - 1; r++)
            {
                var a = V(r, i); var b = V(r, i + 1); var c = V(r + 1, i + 1); var d = V(r + 1, i);
                var mid = (a + b + c + d) / 4;
                m.Triangle(a, b, c, stone, mid with { Y = mid.Y - 0.25f });
                m.Triangle(a, c, d, stone, mid with { Y = mid.Y - 0.25f });
            }
            var ta = V(rings.Length - 1, i); var tb = V(rings.Length - 1, i + 1);
            m.Triangle(ta, tb, top, stone, new Vector3((ta.X + tb.X) / 2, 0.6f, (ta.Z + tb.Z) / 2));
            m.Triangle(V(0, i + 1), V(0, i), bottom, stone, -Vector3.UnitY);
        }
        return m;

        static float Fract(float v) => v - MathF.Floor(v);
    }

    // ---- Buildings. Footprint spans x,z in [0, w] x [0, h]; the front (door) faces +Z. ------------

    /// <summary>Canvas A-frame tent, 1x1. Ridge along Z; the canvas slopes collect snow.</summary>
    public static MeshData Tent()
    {
        var m = new MeshData();
        var canvasLight = SurfaceKind.Rgb(0.74f, 0.66f, 0.50f, SurfaceKind.Foliage);
        var canvasDark = SurfaceKind.Rgb(0.60f, 0.52f, 0.39f, SurfaceKind.Foliage);
        var opening = SurfaceKind.Rgb(0.16f, 0.12f, 0.10f, SurfaceKind.Plain);
        var pole = SurfaceKind.Rgb(0.36f, 0.25f, 0.17f, SurfaceKind.Plain);

        const float b = 0.08f, h = 0.78f, front = 0.94f, back = 0.10f;
        var apexF = new Vector3(0.5f, h, front); var apexB = new Vector3(0.5f, h, back);
        var lf = new Vector3(b, 0, front); var lb = new Vector3(b, 0, back);
        var rf = new Vector3(1 - b, 0, front); var rb = new Vector3(1 - b, 0, back);
        m.Quad(lb, lf, apexF, apexB, new Vector3(-1, 0.6f, 0), canvasLight);   // west slope
        m.Quad(rf, rb, apexB, apexF, new Vector3(1, 0.6f, 0), canvasDark);     // east slope
        m.Triangle(lb, rb, apexB, canvasDark, -Vector3.UnitZ);                  // back wall
        m.Triangle(lf, rf, apexF, canvasLight, Vector3.UnitZ);                  // front wall
        // Door flap: a darker inset triangle just in front of the front wall.
        m.Triangle(new Vector3(0.32f, 0, front + 0.005f), new Vector3(0.68f, 0, front + 0.005f),
                   new Vector3(0.5f, h * 0.62f, front + 0.005f), opening, Vector3.UnitZ);
        Box(m, new Vector3(0.5f, h + 0.06f, front), new Vector3(0.05f, 0.16f, 0.05f), pole);
        Box(m, new Vector3(0.5f, h + 0.06f, back), new Vector3(0.05f, 0.16f, 0.05f), pole);
        return m;
    }

    /// <summary>Log cabin, 2x2: plank walls, door and window in front, pitched roof, stone chimney.</summary>
    public static MeshData Cabin()
    {
        var m = new MeshData();
        var wall = SurfaceKind.Rgb(0.47f, 0.32f, 0.21f, SurfaceKind.Plain);
        var wallDark = SurfaceKind.Rgb(0.36f, 0.24f, 0.16f, SurfaceKind.Plain);
        var roof = SurfaceKind.Rgb(0.42f, 0.24f, 0.19f, SurfaceKind.Foliage);
        var door = SurfaceKind.Rgb(0.20f, 0.14f, 0.11f, SurfaceKind.Plain);
        var window = SurfaceKind.Rgb(0.13f, 0.15f, 0.20f, SurfaceKind.Plain);
        var stone = SurfaceKind.Rgb(0.45f, 0.44f, 0.45f, SurfaceKind.Foliage);

        const float x0 = 0.15f, x1 = 1.85f, z0 = 0.2f, z1 = 1.8f, wallH = 0.95f, ridge = 1.65f, eave = 0.18f;
        Box(m, new Vector3(1, wallH / 2, 1), new Vector3(x1 - x0, wallH, z1 - z0), wall);
        // Log courses: thin darker bands around the walls read as stacked logs.
        for (float y = 0.22f; y < wallH; y += 0.24f)
            Box(m, new Vector3(1, y, 1), new Vector3(x1 - x0 + 0.04f, 0.035f, z1 - z0 + 0.04f), wallDark);
        // Gable triangles (east/west) under the roof.
        var gW0 = new Vector3(x0, wallH, z0); var gW1 = new Vector3(x0, wallH, z1); var gWt = new Vector3(x0, ridge, 1);
        m.Triangle(gW0, gW1, gWt, wall, -Vector3.UnitX);
        var gE0 = new Vector3(x1, wallH, z0); var gE1 = new Vector3(x1, wallH, z1); var gEt = new Vector3(x1, ridge, 1);
        m.Triangle(gE0, gE1, gEt, wall, Vector3.UnitX);
        // Roof: two slopes (north/south) with overhang; top faces collect snow.
        var rN0 = new Vector3(x0 - eave, wallH - 0.1f, z0 - eave); var rN1 = new Vector3(x1 + eave, wallH - 0.1f, z0 - eave);
        var rS0 = new Vector3(x0 - eave, wallH - 0.1f, z1 + eave); var rS1 = new Vector3(x1 + eave, wallH - 0.1f, z1 + eave);
        var rT0 = new Vector3(x0 - eave, ridge + 0.04f, 1); var rT1 = new Vector3(x1 + eave, ridge + 0.04f, 1);
        m.Quad(rN0, rN1, rT1, rT0, new Vector3(0, 0.7f, -1), roof);
        m.Quad(rS0, rS1, rT1, rT0, new Vector3(0, 0.7f, 1), roof);
        m.Quad(rN0, rN1, rT1, rT0, new Vector3(0, -0.7f, 1), wallDark);   // undersides
        m.Quad(rS0, rS1, rT1, rT0, new Vector3(0, -0.7f, -1), wallDark);
        // Front: door under the centre, window to the left (see CabinWindow for the lit version).
        Box(m, new Vector3(1.25f, 0.36f, z1 + 0.01f), new Vector3(0.36f, 0.72f, 0.04f), door);
        Box(m, new Vector3(0.62f, 0.55f, z1 + 0.01f), new Vector3(0.34f, 0.26f, 0.04f), window);
        // Chimney through the north slope.
        Prism(m, new Vector3(1.55f, 1.0f, 0.62f), 0.15f, 0.95f, 5, stone);
        return m;
    }

    /// <summary>Glowing window pane drawn over the cabin window when someone is inside at night.</summary>
    public static MeshData CabinWindow()
    {
        var m = new MeshData();
        Box(m, new Vector3(0.62f, 0.55f, 1.835f), new Vector3(0.28f, 0.2f, 0.02f), SurfaceKind.Rgb(1f, 0.78f, 0.40f, SurfaceKind.Plain));
        return m;
    }

    /// <summary>Construction site floor: plank platform with a darker frame, w x h tiles.</summary>
    public static MeshData Foundation(int w, int h)
    {
        var m = new MeshData();
        var plank = SurfaceKind.Rgb(0.55f, 0.40f, 0.26f, SurfaceKind.Foliage);
        var frame = SurfaceKind.Rgb(0.33f, 0.23f, 0.15f, SurfaceKind.Plain);
        Box(m, new Vector3(w / 2f, 0.05f, h / 2f), new Vector3(w - 0.1f, 0.1f, h - 0.1f), frame);
        for (float z = 0.15f; z < h - 0.1f; z += 0.3f)
            Box(m, new Vector3(w / 2f, 0.11f, z + 0.12f), new Vector3(w - 0.2f, 0.03f, 0.24f), plank);
        // Corner posts.
        foreach (var (px, pz) in new[] { (0.12f, 0.12f), (w - 0.12f, 0.12f), (0.12f, h - 0.12f), (w - 0.12f, h - 0.12f) })
            Box(m, new Vector3(px, 0.35f, pz), new Vector3(0.09f, 0.7f, 0.09f), frame);
        return m;
    }

    /// <summary>A stack of logs (delivered material), scaled by the client to show progress.</summary>
    public static MeshData LogPile()
    {
        var m = new MeshData();
        var bark = SurfaceKind.Rgb(0.40f, 0.27f, 0.17f, SurfaceKind.Foliage);
        for (int row = 0; row < 3; row++)
            for (int k = 0; k < 3 - row; k++)
            {
                float z = -0.14f + k * 0.14f + row * 0.07f;
                float y = 0.07f + row * 0.12f;
                Box(m, new Vector3(0, y, z), new Vector3(0.5f, 0.12f, 0.12f), bark);
            }
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
