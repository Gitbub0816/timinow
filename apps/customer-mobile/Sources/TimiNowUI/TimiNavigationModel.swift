#if !SKIP && !os(Android)
import Foundation
import TimiNowCore

// The presentation model for turn-by-turn navigation: what the screen (and,
// later, CarPlay) needs to draw, with every Mapbox type translated away.
// This is the seam docs/NAVIGATION.md describes — Mapbox supplies the
// navigation intelligence (TimiNavigationSession.swift), these types carry
// it, and TimiNavigationChrome.swift draws it. Nothing here imports Mapbox,
// which is also what lets the default CI build (no TIMI_MAPBOX) compile the
// entire chrome: only the session adapter is Mapbox-gated.

/// Every maneuver the glyph system can draw. The vocabulary mirrors the OSRM
/// maneuver types/modifiers Mapbox reports, flattened into one enum so a
/// glyph, a lane arrow, and a CarPlay symbol can all switch on the same case.
enum TimiManeuverKind: String, Sendable {
    case depart
    case straight
    case slightLeft, slightRight
    case left, right
    case sharpLeft, sharpRight
    case uTurn
    case mergeLeft, mergeRight
    case forkLeft, forkRight
    case keepLeft, keepRight
    case onRampLeft, onRampRight
    case offRampLeft, offRampRight
    case roundabout
    case roundaboutLeft, roundaboutRight, roundaboutStraight
    case arrive, arriveLeft, arriveRight
}

/// One lane at the approach to a maneuver. `arrows` is everything painted on
/// the pavement for that lane; `active` marks the arrow the driver should
/// actually follow (nil when the lane is not usable for this maneuver).
struct TimiLane: Equatable, Sendable, Identifiable {
    let id: Int
    var arrows: [TimiManeuverKind]
    var isUsable: Bool
    var active: TimiManeuverKind?
}

/// The maneuver the banner shows right now.
struct TimiManeuver: Equatable, Sendable {
    var kind: TimiManeuverKind
    var distanceMeters: Double
    /// The road/exit being turned onto — "Grand Street", "Exit 24".
    var primaryText: String
    /// A second line where the SDK supplies one — "Toward San Jose".
    var secondaryText: String?
    /// Exit heading for roundabouts, in degrees clockwise from entry (so the
    /// glyph can rotate its exit arrow); nil for everything else.
    var roundaboutExitDegrees: Double?
    var lanes: [TimiLane]
}

/// The maneuver after this one, shown as a compact "then" chip when the two
/// are close together.
struct TimiNextManeuver: Equatable, Sendable {
    var kind: TimiManeuverKind
    var text: String
}

/// Trip-level progress for the status card.
struct TimiTripProgress: Equatable, Sendable {
    var secondsRemaining: Double
    var metersRemaining: Double
    var eta: Date
}

/// Current speed and the posted limit, both in meters per second. `isMUTCD`
/// selects the US regulatory sign shape; anything else draws the Vienna ring.
struct TimiSpeedInfo: Equatable, Sendable {
    var currentMetersPerSecond: Double
    var limitMetersPerSecond: Double?
    var isMUTCD: Bool
}

/// The one transient condition the banner area reports. Ordered by severity:
/// a session shows the highest-priority state it is currently in.
enum TimiNavAlert: Equatable, Sendable {
    /// The navigator says the vehicle left the route; a reroute is coming.
    case offRoute
    /// A new route is being fetched.
    case rerouting
    /// A reroute just landed; shown briefly so the route change reads as
    /// deliberate rather than as the line glitching.
    case rerouted
    /// The SDK found a materially faster route the driver can accept.
    case fasterRouteAvailable
    /// GPS quality dropped; guidance is best-effort until it recovers.
    case gpsUncertain
    /// Rerouting failed or the navigator reported an error.
    case error(String)
}

/// What the driver has asked the map camera to do. Deliberately smaller than
/// the SDK's own camera vocabulary: `idle` is something the engine does to
/// itself when a pan interrupts following, never something this app requests.
enum TimiCameraMode: Equatable, Sendable {
    /// Locked to the vehicle: pitched, course-up, framed on the next maneuver.
    case following
    /// Pulled back to the whole remaining route.
    case overview
}

/// Where the trip is in its lifecycle. Drives which bottom card is shown.
enum TimiNavPhase: Equatable, Sendable {
    /// Route requested, guidance not yet running.
    case preparing
    /// Ordinary guidance.
    case guiding
    /// Within the approach window of the clinic: the trip card gives way to
    /// clinic identity and a call action.
    case approaching
    /// The SDK reported arrival at the final destination.
    case arrived
}

/// Distance formatting in the register navigation apps use: big round
/// numbers that can be read at a glance, never false precision.
enum TimiNavFormat {
    static func distance(meters: Double, units: DistanceUnits) -> String {
        if units == .metric {
            if meters < 20 { return "Now" }
            if meters < 900 {
                let step: Double = meters < 300 ? 50 : 100
                return "\(Int((meters / step).rounded() * step)) m"
            }
            let km = meters / 1000
            return km < 10 ? String(format: "%.1f km", km) : "\(Int(km.rounded())) km"
        }
        let feet = meters * 3.28084
        if feet < 60 { return "Now" }
        if feet < 900 {
            let step: Double = 100
            return "\(Int((feet / step).rounded() * step)) ft"
        }
        let miles = meters / 1609.344
        return miles < 10 ? String(format: "%.1f mi", miles) : "\(Int(miles.rounded())) mi"
    }

    static func duration(seconds: Double) -> String {
        let minutes = Int((seconds / 60).rounded())
        if minutes < 60 { return "\(max(minutes, 1)) min" }
        return "\(minutes / 60) hr \(minutes % 60) min"
    }

    static func eta(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    static func speed(metersPerSecond: Double, units: DistanceUnits) -> Int {
        let value = units == .metric ? metersPerSecond * 3.6 : metersPerSecond * 2.23694
        return max(0, Int(value.rounded()))
    }
}
#endif
