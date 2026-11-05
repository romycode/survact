namespace Survact.Sim.World;

/// <summary>
/// Tile identity. Stored in saves as a byte, so append only: never reorder or reuse values.
/// Properties (cost, amounts, what it depletes to) live in data — see <see cref="TileTable"/>.
/// </summary>
public enum Tile : byte
{
    Grass = 0,
    Water = 1,
    Rock = 2,
    Tree = 3,
    Bush = 4,
    Snow = 5,
}
