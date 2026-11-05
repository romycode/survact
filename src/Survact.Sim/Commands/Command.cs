namespace Survact.Sim.Commands;

/// <summary>Stored in saves and replay logs as a byte: append only, never reorder.</summary>
public enum CommandKind : byte
{
    SpawnColonists = 1,
    AddStock = 2,
    SetClimateOffset = 3,
}

/// <summary>
/// The only way anything outside the simulation changes it: player input, UI, debug console,
/// AI directors, network. Commands are queued, applied at the start of the next tick and logged,
/// so seed + command log reproduces a session exactly (replays, bug reports, multiplayer lockstep).
///
/// Fixed-size blittable payload on purpose: trivial to serialize, hash and send over the wire.
/// Build them through the factory methods, never with raw A/B/C.
/// </summary>
public readonly record struct Command(CommandKind Kind, int A = 0, int B = 0, int C = 0)
{
    /// <summary>Debug/cheat: spawn colonists on the given tile (must be walkable).</summary>
    public static Command SpawnColonists(int x, int y, int count) => new(CommandKind.SpawnColonists, x, y, count);

    /// <summary>Debug/cheat: add (or remove, if negative) stock. Totals never go below zero.</summary>
    public static Command AddStock(int wood, int food) => new(CommandKind.AddStock, wood, food);

    /// <summary>Debug/scenario: shift the climate curve, in tenths of a degree for exact replay.</summary>
    public static Command SetClimateOffset(float degrees) =>
        new(CommandKind.SetClimateOffset, (int)MathF.Round(degrees * 10f));

    public override string ToString() => Kind switch
    {
        CommandKind.SpawnColonists => $"SpawnColonists({A},{B} x{C})",
        CommandKind.AddStock => $"AddStock(wood {A:+#;-#;0}, food {B:+#;-#;0})",
        CommandKind.SetClimateOffset => $"SetClimateOffset({A / 10f:+0.0;-0.0}°C)",
        _ => $"{Kind}({A},{B},{C})",
    };
}

/// <summary>A command and the tick it was applied on.</summary>
public readonly record struct LoggedCommand(long Tick, Command Command);
