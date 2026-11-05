namespace Survact.Sim.Commands;

/// <summary>
/// Validates and applies commands. Validation lives here, not in the UI: the simulation must
/// never trust its input (a replay file, a network peer or a typo in the console are all input).
/// </summary>
internal static class CommandProcessor
{
    public const int MaxSpawnPerCommand = 1000;

    /// <summary>Returns null when applied, or the reason it was rejected.</summary>
    public static string? Apply(Simulation sim, in Command cmd)
    {
        switch (cmd.Kind)
        {
            case CommandKind.SpawnColonists:
            {
                var map = sim.Map;
                if (!map.InBounds(cmd.A, cmd.B)) return "tile out of bounds";
                if (!map.Rules.Walkable(map.Get(cmd.A, cmd.B))) return "tile is not walkable";
                if (cmd.C is < 1 or > MaxSpawnPerCommand) return $"count must be 1..{MaxSpawnPerCommand}";
                for (int i = 0; i < cmd.C; i++) sim.Colonists.Spawn(cmd.A + 0.5f, cmd.B + 0.5f);
                return null;
            }

            case CommandKind.AddStock:
                sim.Colony.Wood = (int)Math.Clamp((long)sim.Colony.Wood + cmd.A, 0, int.MaxValue);
                sim.Colony.Food = (int)Math.Clamp((long)sim.Colony.Food + cmd.B, 0, int.MaxValue);
                return null;

            case CommandKind.SetClimateOffset:
                if (cmd.A is < -1000 or > 1000) return "offset must be within ±100°C";
                sim.ClimateOffset = cmd.A / 10f;
                return null;

            default:
                return $"unknown command kind {(byte)cmd.Kind}";
        }
    }
}
