using Survact.Sim.World;

namespace Survact.Sim.Pathfinding;

/// <summary>
/// Connected components of walkable tiles. Answers "can A ever reach B?" in O(1), so the AI
/// never launches an A* that is doomed to fail. Rebuilt lazily only when walkability changes
/// (building walls, bridges, digging) — resource depletion keeps tiles walkable and costs nothing.
/// </summary>
public sealed class Regions
{
    public const int None = -1;

    private readonly TileMap _map;
    private readonly int[] _id;
    private readonly int[] _queue;
    private int _builtVersion = -1;
    private readonly List<int> _sizes = [];

    public Regions(TileMap map)
    {
        _map = map;
        _id = new int[map.Count];
        _queue = new int[map.Count];
    }

    public int RegionCount { get { EnsureBuilt(); return _sizes.Count; } }
    public int SizeOf(int region) => _sizes[region];

    public int Of(int index)
    {
        EnsureBuilt();
        return _id[index];
    }

    public bool Connected(int a, int b)
    {
        EnsureBuilt();
        int ra = _id[a];
        return ra != None && ra == _id[b];
    }

    public int Largest()
    {
        EnsureBuilt();
        int best = None;
        for (int r = 0; r < _sizes.Count; r++)
            if (best == None || _sizes[r] > _sizes[best]) best = r;
        return best;
    }

    public void EnsureBuilt()
    {
        if (_builtVersion == _map.WalkabilityVersion) return;
        Rebuild();
        _builtVersion = _map.WalkabilityVersion;
    }

    private void Rebuild()
    {
        Array.Fill(_id, None);
        _sizes.Clear();
        int width = _map.Width, height = _map.Height;

        for (int seed = 0; seed < _map.Count; seed++)
        {
            if (_id[seed] != None || !_map.Rules.Walkable(_map.Get(seed))) continue;

            int region = _sizes.Count;
            int head = 0, tail = 0, size = 0;
            _queue[tail++] = seed;
            _id[seed] = region;

            while (head < tail)
            {
                int cur = _queue[head++];
                size++;
                int x = cur % width, y = cur / width;
                if (x > 0) Visit(cur - 1);
                if (x < width - 1) Visit(cur + 1);
                if (y > 0) Visit(cur - width);
                if (y < height - 1) Visit(cur + width);
            }
            _sizes.Add(size);

            void Visit(int n)
            {
                if (_id[n] != None || !_map.Rules.Walkable(_map.Get(n))) return;
                _id[n] = region;
                _queue[tail++] = n;
            }
        }
    }
}
