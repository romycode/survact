using System.Numerics;

namespace Survact.Game.World.Geometry;

/// <summary>
/// Engine-independent triangle soup: one normal per face (flat-shaded low-poly) and a vertex color
/// whose alpha is the surface kind read by lowpoly.gdshader (see <see cref="SurfaceKind"/>).
/// Kept free of Godot types so meshes can be built and checked headless (tests, previews, tools).
/// </summary>
public sealed class MeshData
{
    public readonly List<Vector3> Positions = [];
    public readonly List<Vector3> Normals = [];
    public readonly List<Vector4> Colors = [];

    public int VertexCount => Positions.Count;

    public void Triangle(Vector3 a, Vector3 b, Vector3 c, Vector4 color, Vector3? outwardHint = null)
        => Triangle(a, b, c, color, color, color, outwardHint);

    public void Triangle(Vector3 a, Vector3 b, Vector3 c, Vector4 ca, Vector4 cb, Vector4 cc, Vector3? outwardHint = null)
    {
        var n = Vector3.Normalize(Vector3.Cross(b - a, c - a));
        if (float.IsNaN(n.X)) return; // degenerate
        if (outwardHint is { } hint && Vector3.Dot(n, hint) < 0) n = -n;
        Add(a, n, ca);
        Add(b, n, cb);
        Add(c, n, cc);
    }

    /// <summary>Quad a-b-c-d (any winding); the normal is forced to point along <paramref name="outward"/>.</summary>
    public void Quad(Vector3 a, Vector3 b, Vector3 c, Vector3 d, Vector3 outward, Vector4 color)
    {
        var n = Vector3.Normalize(outward);
        Add(a, n, color); Add(b, n, color); Add(c, n, color);
        Add(a, n, color); Add(c, n, color); Add(d, n, color);
    }

    public void Append(MeshData other, Matrix4x4 transform)
    {
        for (int i = 0; i < other.VertexCount; i++)
        {
            Positions.Add(Vector3.Transform(other.Positions[i], transform));
            Normals.Add(Vector3.Normalize(Vector3.TransformNormal(other.Normals[i], transform)));
            Colors.Add(other.Colors[i]);
        }
    }

    private void Add(Vector3 p, Vector3 n, Vector4 c)
    {
        Positions.Add(p);
        Normals.Add(n);
        Colors.Add(c);
    }
}

/// <summary>Vertex color alpha values understood by lowpoly.gdshader.</summary>
public static class SurfaceKind
{
    public const float Ground = 1.0f;
    public const float Foliage = 0.66f;
    public const float Water = 0.33f;
    public const float RockFace = 0.12f;
    public const float Plain = 0.0f;

    public static Vector4 Rgb(float r, float g, float b, float kind) => new(r, g, b, kind);
}
