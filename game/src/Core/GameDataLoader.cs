using Godot;
using Survact.Sim.Data;

namespace Survact.Game.Core;

/// <summary>
/// Reads game data through Godot's virtual filesystem, so it works both in the editor and from
/// the exported .pck (System.IO cannot see res:// in an export). Validation is the sim's job.
/// Export presets must include "*.json" in "Filters to export non-resource files".
/// </summary>
public static class GameDataLoader
{
    public const string BalancePath = "res://data/balance.json";

    public static GameData Load(string path = BalancePath)
    {
        string text = Godot.FileAccess.GetFileAsString(path);
        if (string.IsNullOrEmpty(text))
            throw new GameDataException($"{path}: not found or empty ({Godot.FileAccess.GetOpenError()}).");
        return GameData.FromJson(text, path);
    }
}
