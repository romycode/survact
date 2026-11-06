using Survact.Sim.Data;

namespace Survact.Sim.Buildings;

/// <summary>Stored as a byte: append only.</summary>
public enum BuildingStage : byte
{
    /// <summary>Construction site: blocks its footprint, waits for wood, then for work.</summary>
    Site = 0,
    Built = 1,
    /// <summary>Tombstone: the slot is kept so building ids stay stable (no reuse).</summary>
    Removed = 2,
}

/// <summary>One building. Plain data; all logic lives in systems and BuildRules.</summary>
public struct Building
{
    public int Type;
    public int X, Y;               // top-left (north-west) tile of the footprint
    public BuildingStage Stage;
    public int Wood;               // delivered
    public int WoodIncoming;       // carried by haulers right now (prevents over-delivery)
    public int Haulers;            // colonists heading to the stockpile to fetch wood for it
    public int Work;               // ticks of work done
    public int Builders;           // colonists assigned to build it
    public int Occupants;          // colonists sheltered inside or on their way (reserved slots)
}

/// <summary>
/// All buildings, by id. Ids are stable for the whole game (removed buildings stay as tombstones),
/// so colonists, commands and the client can refer to a building by id safely.
/// </summary>
public sealed class BuildingStore
{
    private Building[] _items = new Building[16];

    public int Count { get; private set; }

    /// <summary>Bumped on every add/stage change. Renderers rebuild their views when it changes.</summary>
    public int Version { get; internal set; }

    public ref Building this[int id] => ref _items[id];

    internal ReadOnlySpan<Building> AsSpan() => _items.AsSpan(0, Count);

    internal int Add(in Building b)
    {
        if (Count == _items.Length) Array.Resize(ref _items, _items.Length * 2);
        _items[Count] = b;
        Version++;
        return Count++;
    }

    public static (int X, int Y) EntranceOf(in Building b, BuildingType type) => (b.X + type.Width / 2, b.Y + type.Height);
}
