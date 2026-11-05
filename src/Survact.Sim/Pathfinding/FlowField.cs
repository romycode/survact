using Survact.Sim.World;

namespace Survact.Sim.Pathfinding;

/// <summary>
/// Walking-cost distance from every tile to one destination (the stockpile). Built once with
/// Dijkstra over the whole map; afterwards any number of colonists find their way home by
/// stepping to the neighbour with the lowest distance — O(1) per step, no per-colonist search,
/// no stored path. Rebuilt lazily when walkability changes or the destination moves.
/// Same pattern later for every shared destination: heat sources, shelters, rally points.
/// </summary>
public sealed class FlowField
{
    public const int Unreachable = int.MaxValue;

    private readonly TileMap _map;
    private readonly int[] _dist;
    private int _target = -1;
    private int _builtVersion = -1;

    public FlowField(TileMap map)
    {
        _map = map;
        _dist = new int[map.Count];
    }

    public int Target => _target;
    public long Rebuilds { get; private set; }

    public void SetTarget(int target)
    {
        if (target == _target) return;
        _target = target;
        _builtVersion = -1;
    }

    public int DistanceAt(int index)
    {
        EnsureBuilt();
        return _dist[index];
    }

    /// <summary>Neighbour one step closer to the target, or -1 if unreachable / already there.</summary>
    public int Next(int index)
    {
        EnsureBuilt();
        int best = -1, bestDist = _dist[index];
        if (bestDist == Unreachable || bestDist == 0) return -1;

        int width = _map.Width;
        int x = index % width, y = index / width;
        // Fixed neighbour order keeps ties deterministic.
        if (y > 0) Consider(index - width);
        if (x < width - 1) Consider(index + 1);
        if (y < _map.Height - 1) Consider(index + width);
        if (x > 0) Consider(index - 1);
        return best;

        void Consider(int n)
        {
            if (_dist[n] < bestDist)
            {
                bestDist = _dist[n];
                best = n;
            }
        }
    }

    public void EnsureBuilt()
    {
        if (_builtVersion == _map.WalkabilityVersion) return;
        Build();
        _builtVersion = _map.WalkabilityVersion;
    }

    private void Build()
    {
        Rebuilds++;
        Array.Fill(_dist, Unreachable);
        if (_target < 0) return;

        int width = _map.Width, height = _map.Height;
        var open = new PriorityQueue<int, int>();
        _dist[_target] = 0;
        open.Enqueue(_target, 0);

        while (open.TryDequeue(out int cur, out int d))
        {
            if (d != _dist[cur]) continue;
            int x = cur % width, y = cur / width;
            // Cost of moving FROM neighbour INTO cur = cost of cur's terrain, mirrored as entering the neighbour.
            if (x > 0) Relax(cur - 1);
            if (x < width - 1) Relax(cur + 1);
            if (y > 0) Relax(cur - width);
            if (y < height - 1) Relax(cur + width);

            void Relax(int n)
            {
                int cost = TileRules.MoveCost(_map.Get(n));
                if (cost == 0) return;
                int nd = d + TileRules.MoveCost(_map.Get(cur));
                if (nd >= _dist[n]) return;
                _dist[n] = nd;
                open.Enqueue(n, nd);
            }
        }
    }
}
