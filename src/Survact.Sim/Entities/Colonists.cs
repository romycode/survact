namespace Survact.Sim.Entities;

public enum ColonistState : byte
{
    Idle,
    Walking,
    Gathering,
    Eating,
    Warming,
}

/// <summary>How a walking colonist navigates.</summary>
public enum Nav : byte
{
    /// <summary>Follows the explicit path in its path slice.</summary>
    Path,

    /// <summary>Descends the stockpile flow field until within Timer tiles of the stockpile.</summary>
    Stockpile,
}

public enum Job : byte
{
    None,
    Wood,
    Food,
    Eat,
    Warm,
}

/// <summary>
/// Struct-of-arrays storage. Entity i is the i-th slot in every array; slots [0, Count) are alive.
/// Removal is swap-with-last, so indices are NOT stable across ticks. When something outside the
/// sim needs to hold a reference to a colonist, add a generational handle table here.
/// </summary>
public sealed class Colonists
{
    public const int MaxPathLength = 512;

    public int Count { get; private set; }
    public int Capacity => X.Length;

    // Position in tile units (tile centre = x + 0.5). Prev* = position at the start of the tick, for render interpolation.
    public float[] X = [], Y = [], PrevX = [], PrevY = [];

    // Needs in [0, 1]. 0 = death.
    public float[] Hunger = [], Warmth = [];

    public ColonistState[] State = [];
    public Job[] Job = [];
    public Nav[] Nav = [];
    public int[] Target = [];       // tile index of current job target (-1 none)
    public int[] Timer = [];        // ticks left in current action / think cooldown
    public int[] Carry = [];        // units carried (resource defined by Job)

    // Paths: fixed-size slice per colonist in one pooled array. No per-path allocations.
    public int[] Path = [];
    public int[] PathLength = [];
    public int[] PathPos = [];

    public Colonists(int capacity) => Resize(Math.Max(capacity, 16));

    public Span<int> PathSlice(int i) => Path.AsSpan(i * MaxPathLength, MaxPathLength);

    public int Spawn(float x, float y)
    {
        if (Count == Capacity) Resize(Capacity * 2);
        int i = Count++;
        X[i] = PrevX[i] = x;
        Y[i] = PrevY[i] = y;
        Hunger[i] = 1f;
        Warmth[i] = 1f;
        State[i] = ColonistState.Idle;
        Job[i] = Entities.Job.None;
        Nav[i] = Entities.Nav.Path;
        Target[i] = -1;
        Timer[i] = 0;
        Carry[i] = 0;
        PathLength[i] = 0;
        PathPos[i] = 0;
        return i;
    }

    /// <summary>Swap-remove. The colonist previously at Count-1 now lives at <paramref name="i"/>.</summary>
    public void RemoveAt(int i)
    {
        int last = --Count;
        if (i == last) return;

        X[i] = X[last]; Y[i] = Y[last]; PrevX[i] = PrevX[last]; PrevY[i] = PrevY[last];
        Hunger[i] = Hunger[last]; Warmth[i] = Warmth[last];
        State[i] = State[last]; Job[i] = Job[last]; Nav[i] = Nav[last]; Target[i] = Target[last];
        Timer[i] = Timer[last]; Carry[i] = Carry[last];
        PathLength[i] = PathLength[last]; PathPos[i] = PathPos[last];
        Array.Copy(Path, last * MaxPathLength, Path, i * MaxPathLength, PathLength[last]);
    }

    public void SnapshotPrevious()
    {
        Array.Copy(X, PrevX, Count);
        Array.Copy(Y, PrevY, Count);
    }

    private void Resize(int capacity)
    {
        Array.Resize(ref X, capacity); Array.Resize(ref Y, capacity);
        Array.Resize(ref PrevX, capacity); Array.Resize(ref PrevY, capacity);
        Array.Resize(ref Hunger, capacity); Array.Resize(ref Warmth, capacity);
        Array.Resize(ref State, capacity); Array.Resize(ref Job, capacity); Array.Resize(ref Nav, capacity);
        Array.Resize(ref Target, capacity); Array.Resize(ref Timer, capacity);
        Array.Resize(ref Carry, capacity);
        Array.Resize(ref PathLength, capacity); Array.Resize(ref PathPos, capacity);
        Array.Resize(ref Path, capacity * MaxPathLength);
    }

    internal void SetCount(int count)
    {
        if (count > Capacity) Resize(Math.Max(count, Capacity * 2));
        Count = count;
    }
}
