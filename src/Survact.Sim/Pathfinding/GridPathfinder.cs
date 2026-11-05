using Survact.Sim.World;

namespace Survact.Sim.Pathfinding;

/// <summary>What a search is looking for. Implemented by structs so the JIT specialises the loop (no delegates, no allocs).</summary>
public interface ISearchGoal
{
    bool IsGoal(int index);

    /// <summary>Admissible estimate to the goal. Return 0 for a pure Dijkstra "nearest match" search.</summary>
    int Heuristic(int index);
}

/// <summary>
/// Best-first search on the 4-neighbour tile grid. One core loop serves two queries:
///  - <see cref="FindPath"/>: A* to a known tile.
///  - <see cref="FindNearest{TGoal}"/>: Dijkstra to the closest tile matching a predicate, by walking cost.
///    This is what "go to the nearest tree" must use: straight-line nearest can sit behind a lake.
/// Zero allocations per query: score arrays are reused and "cleared" by bumping a generation stamp.
/// </summary>
public sealed class GridPathfinder
{
    private readonly TileMap _map;
    private readonly int[] _g;
    private readonly int[] _cameFrom;
    private readonly int[] _stamp;
    private readonly int[] _closedStamp;
    private readonly PriorityQueue<int, long> _open = new();
    private int _generation;

    public long Queries { get; private set; }
    public long Failed { get; private set; }
    public long Expanded { get; private set; }

    public GridPathfinder(TileMap map)
    {
        _map = map;
        _g = new int[map.Count];
        _cameFrom = new int[map.Count];
        _stamp = new int[map.Count];
        _closedStamp = new int[map.Count];
    }

    /// <summary>A* from start to goal. Path excludes start, includes goal. Returns length or -1.</summary>
    public int FindPath(int start, int goal, int maxExpanded, Span<int> output)
    {
        if (!_map.Rules.Walkable(_map.Get(goal))) return -1;
        var target = new TileGoal(goal, _map.Width);
        return Search(start, ref target, maxExpanded, output, out _);
    }

    /// <summary>Dijkstra to the cheapest-to-reach tile satisfying <paramref name="goal"/>.</summary>
    public int FindNearest<TGoal>(int start, ref TGoal goal, int maxExpanded, Span<int> output, out int found)
        where TGoal : struct, ISearchGoal
        => Search(start, ref goal, maxExpanded, output, out found);

    private int Search<TGoal>(int start, ref TGoal goal, int maxExpanded, Span<int> output, out int found)
        where TGoal : struct, ISearchGoal
    {
        Queries++;
        found = -1;

        if (++_generation == int.MaxValue)
        {
            Array.Clear(_stamp);
            Array.Clear(_closedStamp);
            _generation = 1;
        }

        int gen = _generation;
        int width = _map.Width, height = _map.Height;

        _open.Clear();
        _g[start] = 0;
        _cameFrom[start] = -1;
        _stamp[start] = gen;
        _open.Enqueue(start, Priority(0, goal.Heuristic(start)));

        int expanded = 0;
        Span<int> neighbours = stackalloc int[4];

        while (_open.TryDequeue(out int current, out _))
        {
            if (_closedStamp[current] == gen) continue;
            _closedStamp[current] = gen;

            if (goal.IsGoal(current))
            {
                Expanded += expanded;
                found = current;
                int length = Reconstruct(start, current, output);
                if (length < 0) Failed++;
                return length;
            }

            if (++expanded > maxExpanded) break;

            int cx = current % width, cy = current / width;
            int n = 0;
            if (cx > 0) neighbours[n++] = current - 1;
            if (cx < width - 1) neighbours[n++] = current + 1;
            if (cy > 0) neighbours[n++] = current - width;
            if (cy < height - 1) neighbours[n++] = current + width;

            for (int k = 0; k < n; k++)
            {
                int next = neighbours[k];
                if (_closedStamp[next] == gen) continue;
                int cost = _map.Rules.MoveCost(_map.Get(next));
                if (cost == 0) continue;

                int tentative = _g[current] + cost;
                if (_stamp[next] == gen && tentative >= _g[next]) continue;

                _stamp[next] = gen;
                _g[next] = tentative;
                _cameFrom[next] = current;
                _open.Enqueue(next, Priority(tentative, goal.Heuristic(next)));
            }
        }

        Expanded += expanded;
        Failed++;
        return -1;
    }

    /// <summary>Order by f, break ties toward the goal (lower h). Cuts expansions a lot on open terrain.</summary>
    private static long Priority(int g, int h) => ((long)(g + h) << 32) | (uint)h;

    private int Reconstruct(int start, int goal, Span<int> output)
    {
        int length = 0;
        for (int c = goal; c != start; c = _cameFrom[c]) length++;
        if (length > output.Length) return -1;

        int i = length;
        for (int c = goal; c != start; c = _cameFrom[c]) output[--i] = c;
        return length;
    }

    private readonly struct TileGoal(int goal, int width) : ISearchGoal
    {
        private readonly int _gx = goal % width, _gy = goal / width;

        public bool IsGoal(int index) => index == goal;

        public int Heuristic(int index)
            => (Math.Abs(index % width - _gx) + Math.Abs(index / width - _gy)) * 10;
    }
}
