namespace Survact.Sim;

/// <summary>Colony-wide state: stockpile, resources, heater.</summary>
public sealed class ColonyState
{
    public int StockX;
    public int StockY;
    public int Wood;
    public int Food;
    public int Deaths;

    /// <summary>Fractional wood burned, carried between ticks.</summary>
    public float BurnAccumulator;

    public bool HeaterLit => Wood > 0;

    public bool InHeatRange(float x, float y, int radius)
    {
        float dx = x - (StockX + 0.5f), dy = y - (StockY + 0.5f);
        return dx * dx + dy * dy <= radius * radius;
    }
}
