using System.Runtime.InteropServices;
using Survact.Sim.Entities;

namespace Survact.Sim.Persistence;

/// <summary>
/// FNV-1a over the full state. Used by tests (determinism, save/load) and later for
/// desync detection if multiplayer/lockstep or replays are ever added.
/// </summary>
internal static class StateHasher
{
    private const ulong Offset = 14695981039346656037UL;
    private const ulong Prime = 1099511628211UL;

    public static ulong Hash(Simulation sim)
    {
        ulong h = Offset;
        Mix(ref h, sim.Tick);
        Mix(ref h, BitConverter.SingleToInt32Bits(sim.Temperature));
        Mix(ref h, sim.ThinkCursor);
        Mix(ref h, (long)sim.Rng.State);

        var map = sim.Map;
        MixBytes(ref h, MemoryMarshal.AsBytes(map.Tiles.AsSpan()));
        MixBytes(ref h, MemoryMarshal.AsBytes(map.Amount.AsSpan()));
        MixBytes(ref h, MemoryMarshal.AsBytes(map.Reserved.AsSpan()));
        MixBytes(ref h, MemoryMarshal.AsBytes(sim.SearchExhaustedUntil.AsSpan()));

        var col = sim.Colony;
        Mix(ref h, col.Wood); Mix(ref h, col.Food); Mix(ref h, col.Deaths);
        Mix(ref h, BitConverter.SingleToInt32Bits(col.BurnAccumulator));

        var c = sim.Colonists;
        int n = c.Count;
        Mix(ref h, n);
        MixBytes(ref h, MemoryMarshal.AsBytes(c.X.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.Y.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.Hunger.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.Warmth.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.State.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.Job.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.Nav.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.Target.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.Timer.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.Carry.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.PathLength.AsSpan(0, n)));
        MixBytes(ref h, MemoryMarshal.AsBytes(c.PathPos.AsSpan(0, n)));
        for (int i = 0; i < n; i++)
            MixBytes(ref h, MemoryMarshal.AsBytes(c.Path.AsSpan(i * Colonists.MaxPathLength, c.PathLength[i])));

        return h;
    }

    private static void Mix(ref ulong h, long value)
    {
        for (int i = 0; i < 8; i++)
        {
            h ^= (byte)(value >> (i * 8));
            h *= Prime;
        }
    }

    private static void MixBytes(ref ulong h, ReadOnlySpan<byte> bytes)
    {
        foreach (byte b in bytes)
        {
            h ^= b;
            h *= Prime;
        }
    }
}
