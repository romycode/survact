using Godot;
using Survact.Sim.Buildings;

namespace Survact.Game.UI;

/// <summary>
/// Player-facing names for ids that come from the sim or the data. Every string is a Tr() literal
/// so tools/i18n.py extracts it. A data entry without a name here shows its raw id.
/// </summary>
public static class Texts
{
    public static string Building(Node n, string id) => id switch
    {
        "tent" => n.Tr("Tent"),
        "cabin" => n.Tr("Cabin"),
        _ => id,
    };

    public static string Placement(Node n, PlacementError e) => e switch
    {
        PlacementError.None => "",
        PlacementError.OutOfBounds => n.Tr("Outside the map"),
        PlacementError.NotClearGround => n.Tr("Needs clear ground: no trees, bushes, rocks or water"),
        PlacementError.NotFlat => n.Tr("The ground must be flat"),
        PlacementError.Occupied => n.Tr("Something is already built there"),
        PlacementError.TooCloseToHeater => n.Tr("Too close to the heater"),
        PlacementError.EntranceBlocked => n.Tr("The entrance is blocked"),
        PlacementError.Unreachable => n.Tr("Colonists can't reach it"),
        PlacementError.BlocksEntrance => n.Tr("It would block another building's entrance"),
        _ => n.Tr("Can't build here"),
    };
}
