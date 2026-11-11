using Godot;
using Survact.Game.World.Geometry;

namespace Survact.Game.World;

/// <summary>Shared mesh resources and instanced scenes for the vertical slice art.</summary>
internal static class VerticalSliceArt
{
    private const string Directory = "res://assets/vertical_slice/";
    private static readonly PackedScene Tent = GD.Load<PackedScene>(Directory + "Survact-tienda-v01.glb");
    private static readonly PackedScene Cabin = GD.Load<PackedScene>(Directory + "Survact-cabana-v01.glb");
    private static readonly Dictionary<(int Width, int Height), Mesh> Foundations = [];

    public static Node3D Shelter(string name, int width, int height) => name switch
    {
        "tent" => Tent.Instantiate<Node3D>(),
        "cabin" => Cabin.Instantiate<Node3D>(),
        _ => new MeshInstance3D { Mesh = MeshConvert.ToArrayMesh(BuildingModels.For(name, width, height)) },
    };

    public static Mesh Foundation(int width, int height)
    {
        if (Foundations.TryGetValue((width, height), out var mesh)) return mesh;

        mesh = (width, height) switch
        {
            (1, 1) => LoadMesh("Survact-cimientos-1x1-v01.glb"),
            (2, 2) => LoadMesh("Survact-cimientos-2x2-v01.glb"),
            _ => MeshConvert.ToArrayMesh(LowPoly.Foundation(width, height)),
        };
        Foundations.Add((width, height), mesh);
        return mesh;
    }

    public static Mesh LoadMesh(string file)
    {
        var root = GD.Load<PackedScene>(Directory + file).Instantiate<Node3D>();
        try
        {
            // The GLTF importer may rename a mesh to disambiguate it from its parent.
            if (root is MeshInstance3D ownMesh && ownMesh.Mesh is Mesh mesh) return mesh;
            var children = root.FindChildren("*", "MeshInstance3D", recursive: true, owned: false);
            if (children.Count == 1 && children[0] is MeshInstance3D child && child.Mesh is Mesh childMesh)
                return childMesh;
            throw new InvalidOperationException($"Expected a single mesh in {file}.");
        }
        finally
        {
            root.Free();
        }
    }
}
