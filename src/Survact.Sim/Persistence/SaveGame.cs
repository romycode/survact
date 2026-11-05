using System.Runtime.InteropServices;
using Survact.Sim.Commands;
using Survact.Sim.Data;
using Survact.Sim.Entities;
using Survact.Sim.World;

namespace Survact.Sim.Persistence;

/// <summary>
/// Binary save format. Because the sim is plain data, a save is a straight dump of its arrays.
/// Bump <see cref="Version"/> on any layout change and add a migration in <see cref="Load"/>.
/// Game data (balance) is NOT stored: a save loads with the current data, so balance patches
/// apply to existing saves, as players expect.
/// v2: climate offset + pending commands. v3: terrain levels.
/// </summary>
public static class SaveGame
{
    private const uint Magic = 0x54565253; // "SRVT"
    public const int Version = 3;

    public static void Save(Simulation sim, Stream stream)
    {
        using var w = new BinaryWriter(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        w.Write(Magic);
        w.Write(Version);

        var s = sim.Settings;
        w.Write(s.Seed); w.Write(s.Width); w.Write(s.Height); w.Write(s.InitialColonists);

        w.Write(sim.Tick);
        w.Write(sim.Temperature);
        w.Write(sim.ClimateOffset);
        w.Write(sim.ThinkCursor);
        sim.Rng.Write(w);

        var map = sim.Map;
        WriteSpan<Tile>(w, map.Tiles);
        WriteSpan<byte>(w, map.Levels);
        WriteSpan<ushort>(w, map.Amount);
        WriteSpan<bool>(w, map.Reserved);
        WriteSpan<long>(w, sim.SearchExhaustedUntil);

        var col = sim.Colony;
        w.Write(col.StockX); w.Write(col.StockY);
        w.Write(col.Wood); w.Write(col.Food); w.Write(col.Deaths);
        w.Write(col.BurnAccumulator);

        var c = sim.Colonists;
        int n = c.Count;
        w.Write(n);
        WriteSpan<float>(w, c.X.AsSpan(0, n)); WriteSpan<float>(w, c.Y.AsSpan(0, n));
        WriteSpan<float>(w, c.PrevX.AsSpan(0, n)); WriteSpan<float>(w, c.PrevY.AsSpan(0, n));
        WriteSpan<float>(w, c.Hunger.AsSpan(0, n)); WriteSpan<float>(w, c.Warmth.AsSpan(0, n));
        WriteSpan<ColonistState>(w, c.State.AsSpan(0, n)); WriteSpan<Job>(w, c.Job.AsSpan(0, n)); WriteSpan<Nav>(w, c.Nav.AsSpan(0, n));
        WriteSpan<int>(w, c.Target.AsSpan(0, n)); WriteSpan<int>(w, c.Timer.AsSpan(0, n));
        WriteSpan<int>(w, c.Carry.AsSpan(0, n));
        WriteSpan<int>(w, c.PathLength.AsSpan(0, n)); WriteSpan<int>(w, c.PathPos.AsSpan(0, n));
        for (int i = 0; i < n; i++) WriteSpan<int>(w, c.Path.AsSpan(i * Colonists.MaxPathLength, c.PathLength[i]));

        // Commands queued but not yet applied (saved between two ticks).
        w.Write(sim.PendingCommands.Count);
        foreach (var cmd in sim.PendingCommands)
        {
            w.Write((byte)cmd.Kind); w.Write(cmd.A); w.Write(cmd.B); w.Write(cmd.C);
        }
    }

    public static Simulation Load(Stream stream, GameData data)
    {
        using var r = new BinaryReader(stream, System.Text.Encoding.UTF8, leaveOpen: true);
        if (r.ReadUInt32() != Magic) throw new InvalidDataException("Not a Survact save.");
        int version = r.ReadInt32();
        if (version != Version) throw new InvalidDataException($"Unsupported save version {version}.");

        var settings = new SimSettings(r.ReadUInt32(), r.ReadInt32(), r.ReadInt32(), r.ReadInt32());
        long tick = r.ReadInt64();
        float temperature = r.ReadSingle();
        float climateOffset = r.ReadSingle();
        int thinkCursor = r.ReadInt32();
        var rng = Pcg32.Read(r);

        var map = new TileMap(settings.Width, settings.Height, data.Tiles);
        ReadSpan<Tile>(r, map.Tiles);
        ReadSpan<byte>(r, map.Levels);
        ReadSpan<ushort>(r, map.Amount);
        ReadSpan<bool>(r, map.Reserved);
        var exhausted = new long[map.ChunksX * map.ChunksY * 2];
        ReadSpan<long>(r, exhausted);

        var colony = new ColonyState
        {
            StockX = r.ReadInt32(), StockY = r.ReadInt32(),
            Wood = r.ReadInt32(), Food = r.ReadInt32(), Deaths = r.ReadInt32(),
            BurnAccumulator = r.ReadSingle(),
        };

        int n = r.ReadInt32();
        var c = new Colonists(n);
        c.SetCount(n);
        ReadSpan<float>(r, c.X.AsSpan(0, n)); ReadSpan<float>(r, c.Y.AsSpan(0, n));
        ReadSpan<float>(r, c.PrevX.AsSpan(0, n)); ReadSpan<float>(r, c.PrevY.AsSpan(0, n));
        ReadSpan<float>(r, c.Hunger.AsSpan(0, n)); ReadSpan<float>(r, c.Warmth.AsSpan(0, n));
        ReadSpan<ColonistState>(r, c.State.AsSpan(0, n)); ReadSpan<Job>(r, c.Job.AsSpan(0, n)); ReadSpan<Nav>(r, c.Nav.AsSpan(0, n));
        ReadSpan<int>(r, c.Target.AsSpan(0, n)); ReadSpan<int>(r, c.Timer.AsSpan(0, n));
        ReadSpan<int>(r, c.Carry.AsSpan(0, n));
        ReadSpan<int>(r, c.PathLength.AsSpan(0, n)); ReadSpan<int>(r, c.PathPos.AsSpan(0, n));
        for (int i = 0; i < n; i++) ReadSpan<int>(r, c.Path.AsSpan(i * Colonists.MaxPathLength, c.PathLength[i]));

        int pendingCount = r.ReadInt32();
        var pending = new List<Command>(pendingCount);
        for (int i = 0; i < pendingCount; i++)
            pending.Add(new Command((CommandKind)r.ReadByte(), r.ReadInt32(), r.ReadInt32(), r.ReadInt32()));

        var sim = new Simulation(settings, data, map, c, colony, rng)
        {
            Tick = tick,
            Temperature = temperature,
            ClimateOffset = climateOffset,
            ThinkCursor = thinkCursor,
        };
        exhausted.CopyTo(sim.SearchExhaustedUntil.AsSpan());
        sim.RestorePending(pending);
        return sim;
    }

    private static void WriteSpan<T>(BinaryWriter w, ReadOnlySpan<T> data) where T : unmanaged
        => w.Write(MemoryMarshal.AsBytes(data));

    private static void ReadSpan<T>(BinaryReader r, Span<T> data) where T : unmanaged
    {
        var bytes = MemoryMarshal.AsBytes(data);
        r.BaseStream.ReadExactly(bytes);
    }
}
