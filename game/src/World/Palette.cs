using Godot;
using Survact.Sim.Entities;

namespace Survact.Game.World;

/// <summary>Colours with gameplay meaning. Terrain/model colours live with their meshes (Geometry/).</summary>
public static class Palette
{
    private static readonly Color Gathering = new("#d9b26a");
    private static readonly Color Eating = new("#f2d55c");
    private static readonly Color Warming = new("#f08a4b");
    private static readonly Color CarryWood = new("#a8724a");
    private static readonly Color CarryFood = new("#d0505a");
    private static readonly Color Walking = new("#8a6fd1"); // violet: reads on grass and on snow, unlike cream/blue
    private static readonly Color Idle = new("#8a8f99");
    private static readonly Color Freezing = new("#7fb4ff");

    /// <summary>Coat colour: what the colonist is doing at a glance. Freezing shifts to icy blue, starving darkens.</summary>
    public static Color ColonistColor(ColonistState state, Job job, int carry, float warmth, float hunger)
    {
        Color c = state switch
        {
            ColonistState.Gathering => Gathering,
            ColonistState.Eating => Eating,
            ColonistState.Warming => Warming,
            ColonistState.Walking when carry > 0 && (job is Job.Wood or Job.Haul) => CarryWood,
            ColonistState.Walking when carry > 0 => CarryFood,
            ColonistState.Walking => Walking,
            _ => Idle,
        };

        if (warmth < 0.35f) c = c.Lerp(Freezing, 1f - warmth / 0.35f);
        if (hunger < 0.35f) c = c.Darkened(0.5f * (1f - hunger / 0.35f));
        return c;
    }
}
