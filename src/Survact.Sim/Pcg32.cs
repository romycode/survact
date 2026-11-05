namespace Survact.Sim;

/// <summary>
/// Deterministic PRNG (PCG-XSH-RR). The whole simulation draws from one instance,
/// so same seed + same inputs = same world. Never use System.Random in the sim.
/// </summary>
public sealed class Pcg32
{
    private ulong _state;
    private ulong _inc;

    public Pcg32(ulong seed, ulong sequence = 54)
    {
        _state = 0;
        _inc = (sequence << 1) | 1;
        NextUInt();
        _state += seed;
        NextUInt();
    }

    private Pcg32() { }

    public ulong State => _state;
    public ulong Inc => _inc;

    public uint NextUInt()
    {
        ulong old = _state;
        _state = unchecked(old * 6364136223846793005UL + _inc);
        uint xorShifted = (uint)(((old >> 18) ^ old) >> 27);
        int rot = (int)(old >> 59);
        return (xorShifted >> rot) | (xorShifted << (-rot & 31));
    }

    /// <summary>Uniform int in [0, maxExclusive).</summary>
    public int Next(int maxExclusive) => (int)(((ulong)NextUInt() * (ulong)maxExclusive) >> 32);

    /// <summary>Uniform float in [0, 1).</summary>
    public float NextFloat() => (NextUInt() >> 8) * (1f / (1 << 24));

    public void Write(BinaryWriter w)
    {
        w.Write(_state);
        w.Write(_inc);
    }

    public static Pcg32 Read(BinaryReader r) => new() { _state = r.ReadUInt64(), _inc = r.ReadUInt64() };
}
