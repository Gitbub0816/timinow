#if !SKIP && !os(Android)
import SwiftUI

// Tími's maneuver symbols, drawn from the navigation asset system.
//
// The geometry is no longer written here. `assets/navigation/Maneuvers` and
// `assets/navigation/Lanes` are the source of truth — the designer's own
// primitives, on a 120×120 box with a 15pt shaft (13pt in lane cells), round
// caps and joins and one shared arrowhead — and this file is the mapping from
// what the navigator reports to which primitive draws it, plus the tint rules.
//
// Everything paints in `currentColor`, so a state is a tint and never a second
// file: a lane that is painted on the road but not the one to follow is the
// same primitive at a lower strength, and there is no "inactive" asset.

extension TimiManeuverKind {
    /// The primitive that draws this maneuver.
    ///
    /// Two cases have no artwork of their own and borrow one, deliberately:
    /// `depart` is a straight shaft (the asset set has no separate depart, and
    /// drawing one would be inventing vocabulary), and `roundaboutStraight` is
    /// the plain roundabout, whose exit already leaves at the top.
    var assetName: String {
        switch self {
        case .depart, .straight: return "Maneuvers/straight"
        case .slightLeft: return "Maneuvers/slight-left"
        case .slightRight: return "Maneuvers/slight-right"
        case .left: return "Maneuvers/turn-left"
        case .right: return "Maneuvers/turn-right"
        case .sharpLeft: return "Maneuvers/sharp-left"
        case .sharpRight: return "Maneuvers/sharp-right"
        case .uTurn: return "Maneuvers/uturn-left"
        case .uTurnRight: return "Maneuvers/uturn-right"
        case .merge: return "Maneuvers/merge"
        case .mergeLeft: return "Maneuvers/merge-left"
        case .mergeRight: return "Maneuvers/merge-right"
        case .forkLeft: return "Maneuvers/fork-left"
        case .forkRight: return "Maneuvers/fork-right"
        case .keepLeft: return "Maneuvers/keep-left"
        case .keepRight: return "Maneuvers/keep-right"
        case .onRampLeft: return "Maneuvers/on-ramp-left"
        case .onRampRight: return "Maneuvers/on-ramp-right"
        case .offRampLeft: return "Maneuvers/off-ramp-left"
        case .offRampRight: return "Maneuvers/off-ramp-right"
        case .exitLeft: return "Maneuvers/exit-left"
        case .exitRight: return "Maneuvers/exit-right"
        case .roundabout, .roundaboutStraight: return "Maneuvers/roundabout"
        case .roundaboutLeft: return "Maneuvers/roundabout-left"
        case .roundaboutRight: return "Maneuvers/roundabout-right"
        case .arrive: return "Maneuvers/arrive"
        case .arriveLeft: return "Maneuvers/arrive-left"
        case .arriveRight: return "Maneuvers/arrive-right"
        }
    }

    /// The lane-cell primitive for this indication, where one exists. Lane
    /// cells are their own drawings — a shorter stem at 13pt, sized to sit in a
    /// row — not the maneuver glyph scaled down.
    var laneAssetName: String? {
        switch self {
        case .straight, .depart: return "Lanes/lane-straight"
        case .slightLeft: return "Lanes/lane-slight-left"
        case .slightRight: return "Lanes/lane-slight-right"
        case .left: return "Lanes/lane-left"
        case .right: return "Lanes/lane-right"
        case .sharpLeft: return "Lanes/lane-sharp-left"
        case .sharpRight: return "Lanes/lane-sharp-right"
        case .uTurn: return "Lanes/lane-uturn-left"
        case .uTurnRight: return "Lanes/lane-uturn-right"
        case .offRampLeft, .exitLeft: return "Lanes/lane-exit-left"
        case .offRampRight, .exitRight: return "Lanes/lane-exit-right"
        default: return nil
        }
    }
}

/// The banner/chip glyph: one maneuver primitive in one tint.
struct TimiManeuverGlyph: View {
    var kind: TimiManeuverKind
    /// Roundabout exit heading, in degrees clockwise from entry.
    ///
    /// The asset set ships left / straight / right roundabouts rather than a
    /// rotatable rim, so a reported heading picks the nearest of the three.
    /// The junction primitives in `assets/navigation/Junctions/Roundabout`
    /// cover 3–9 legs with a chosen exit and are the real answer here — see
    /// docs/NAVIGATION.md for why they are not wired up yet.
    var roundaboutExitDegrees: Double?
    var color: Color

    var body: some View {
        TimiNavArtView(name: resolvedKind.assetName, tint: color)
            .aspectRatio(1, contentMode: .fit)
            .accessibilityHidden(true)
    }

    private var resolvedKind: TimiManeuverKind {
        guard kind == .roundabout, let degrees = roundaboutExitDegrees else { return kind }
        // 0° is back the way we came, 180° straight through.
        switch degrees {
        case ..<120: return .roundaboutRight
        case 240...: return .roundaboutLeft
        default: return .roundaboutStraight
        }
    }
}

/// One lane in the lane-guidance row.
///
/// A lane carries every indication painted on it, and the design system's rule
/// is that combinations need no new artwork: the primitives share a stem, so
/// stacking two of them draws one stem and two branches. The lane to follow is
/// the tint at full strength; the rest recede.
struct TimiLaneGlyph: View {
    var lane: TimiLane
    var activeColor: Color
    var inactiveColor: Color

    var body: some View {
        ZStack {
            ForEach(Array(lane.arrows.enumerated()), id: \.offset) { _, arrow in
                if let asset = arrow.laneAssetName {
                    TimiNavArtView(
                        name: asset,
                        tint: arrow == lane.active ? activeColor : inactiveColor,
                        opacity: arrow == lane.active ? 1 : (lane.isUsable ? 0.55 : 0.3)
                    )
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// A map control, status mark or destination primitive by name — the same
/// renderer, kept separate so call sites read as what they draw.
struct TimiNavIcon: View {
    var name: String
    var color: Color

    var body: some View {
        TimiNavArtView(name: name, tint: color)
            .aspectRatio(1, contentMode: .fit)
            .accessibilityHidden(true)
    }
}
#endif
