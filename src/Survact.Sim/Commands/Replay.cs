namespace Survact.Sim.Commands;

/// <summary>Re-runs a command log on a simulation that starts where the log started.</summary>
public static class Replay
{
    /// <summary>
    /// Steps <paramref name="sim"/> until <paramref name="untilTick"/>, feeding each logged command
    /// on the tick it was originally applied. The log must be ordered by tick (CommandLog is).
    /// </summary>
    public static void Run(Simulation sim, IReadOnlyList<LoggedCommand> log, long untilTick)
    {
        int next = 0;
        while (next < log.Count && log[next].Tick < sim.Tick) next++; // skip anything before the start

        while (sim.Tick < untilTick)
        {
            while (next < log.Count && log[next].Tick == sim.Tick) sim.Enqueue(log[next++].Command);
            sim.Step();
        }
    }
}
