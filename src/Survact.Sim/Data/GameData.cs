using System.Text.Json;
using System.Text.Json.Serialization;
using Survact.Sim.World;

namespace Survact.Sim.Data;

/// <summary>
/// Immutable, validated game data ready for the simulation. Loaded once from JSON text
/// (the host decides where the text comes from: Godot's res://, a test fixture, a mod folder).
/// </summary>
public sealed class GameData
{
    public Balance Balance { get; }
    public TileTable Tiles { get; }
    public BuildingTable Buildings { get; }

    private GameData(Balance balance, TileTable tiles, BuildingTable buildings)
    {
        Balance = balance;
        Tiles = tiles;
        Buildings = buildings;
    }

    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    };

    /// <exception cref="GameDataException">Malformed JSON, unknown/missing fields or invalid values.</exception>
    public static GameData FromJson(string json, string sourceName = "balance.json")
    {
        GameDataDto dto;
        try
        {
            dto = JsonSerializer.Deserialize<GameDataDto>(json, Options)
                  ?? throw new GameDataException($"{sourceName}: empty document.");
        }
        catch (JsonException e)
        {
            throw new GameDataException($"{sourceName}: {e.Message}", e);
        }

        var errors = new List<string>();
        var balance = Balance.Bake(dto, errors);
        var tiles = TileTable.Bake(dto.Tiles, dto.Terrain, errors);
        var buildings = BuildingTable.Bake(dto.Buildings, errors);
        if (errors.Count > 0)
            throw new GameDataException($"{sourceName}:\n  - " + string.Join("\n  - ", errors));

        return new GameData(balance, tiles, buildings);
    }
}

public sealed class GameDataException(string message, Exception? inner = null) : Exception(message, inner);
