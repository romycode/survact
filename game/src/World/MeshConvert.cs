using Godot;
using Survact.Game.World.Geometry;

namespace Survact.Game.World;

/// <summary>Bridges engine-independent MeshData to Godot meshes, and owns the shared world material.</summary>
public static class MeshConvert
{
    private static ShaderMaterial? _lowPoly;

    /// <summary>The one material used by all world geometry (see shaders/lowpoly.gdshader).</summary>
    public static ShaderMaterial LowPolyMaterial =>
        _lowPoly ??= new ShaderMaterial { Shader = GD.Load<Shader>("res://shaders/lowpoly.gdshader") };

    public static ArrayMesh ToArrayMesh(MeshData data)
    {
        int n = data.VertexCount;
        var positions = new Vector3[n];
        var normals = new Vector3[n];
        var colors = new Color[n];
        for (int i = 0; i < n; i++)
        {
            var p = data.Positions[i];
            var nn = data.Normals[i];
            var c = data.Colors[i];
            positions[i] = new Vector3(p.X, p.Y, p.Z);
            normals[i] = new Vector3(nn.X, nn.Y, nn.Z);
            colors[i] = new Color(c.X, c.Y, c.Z, c.W);
        }

        var arrays = new Godot.Collections.Array();
        arrays.Resize((int)Mesh.ArrayType.Max);
        arrays[(int)Mesh.ArrayType.Vertex] = positions;
        arrays[(int)Mesh.ArrayType.Normal] = normals;
        arrays[(int)Mesh.ArrayType.Color] = colors;

        var mesh = new ArrayMesh();
        if (n > 0)
        {
            mesh.AddSurfaceFromArrays(Mesh.PrimitiveType.Triangles, arrays);
            mesh.SurfaceSetMaterial(0, LowPolyMaterial);
        }
        return mesh;
    }
}
