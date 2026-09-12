#if !SKIP && !os(Android)
import SwiftUI
import TimiNowCore

// Tími's navigation chrome: every panel drawn over the map during
// turn-by-turn. All of it is driven by the plain models in
// TimiNavigationModel.swift and callbacks — no Mapbox imports — so the
// default CI build compiles every view here, and a future CarPlay template
// layer can share the models without touching any of this.
//
// The design system translated to a driving context, deliberately: the same
// ink borders and offset shadows as the rest of the app, but shallower
// (2–3pt, not 5–7), fewer simultaneous elements, bigger type, and nothing
// decorative. The banner is the app's navy header made glanceable; the trip
// card is a timiCard stripped to three facts and one clearly-guarded exit.

// MARK: - Palette

/// Navigation-only color pairs. Light mode uses the app's standard tokens;
/// dark mode is its own tuned set, not an inversion — navy surfaces get one
/// step lighter so borders and the map still separate, text goes cream.
private enum NavPalette {
    static let inkRaised = Color(red: 0.10, green: 0.15, blue: 0.31)

    static func card(_ scheme: ColorScheme) -> Color { scheme == .dark ? inkRaised : .white }
    static func cardText(_ scheme: ColorScheme) -> Color { scheme == .dark ? TimiColor.paper : TimiColor.ink }
    static func cardBorder(_ scheme: ColorScheme) -> Color { scheme == .dark ? TimiColor.paper.opacity(0.85) : TimiColor.ink }
    static func mutedText(_ scheme: ColorScheme) -> Color { scheme == .dark ? TimiColor.paper.opacity(0.72) : TimiColor.muted }
}

/// The one shadow used over the map: the app's hard offset shadow at reduced
/// depth, so cards sit on the map without floating away from the brand.
private struct NavCard: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    var fill: Color?
    var radius: CGFloat = 18

    func body(content: Content) -> some View {
        content
            .background(fill ?? NavPalette.card(scheme), in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).stroke(NavPalette.cardBorder(scheme), lineWidth: 2))
            .shadow(color: TimiColor.ink.opacity(scheme == .dark ? Double(0.55) : Double(0.35)), radius: 0, x: 3, y: 3)
    }
}

// MARK: - Maneuver banner

/// The top instruction banner: distance and turn at a glance, street name
/// beneath, lane guidance when the SDK supplies it, and the following
/// maneuver as a compact "then" chip when two turns come close together.
struct TimiManeuverBanner: View {
    var maneuver: TimiManeuver
    var next: TimiNextManeuver?
    var units: DistanceUnits

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 14) {
                TimiManeuverGlyph(kind: maneuver.kind, roundaboutExitDegrees: maneuver.roundaboutExitDegrees, color: TimiColor.gold)
                    .frame(width: 58, height: 58)
                VStack(alignment: .leading, spacing: 2) {
                    Text(TimiNavFormat.distance(meters: maneuver.distanceMeters, units: units))
                        .font(.system(size: 34, weight: .heavy, design: .rounded))
                        .foregroundStyle(.white)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(maneuver.primaryText)
                        .font(.system(size: 20, weight: .bold))
                        .foregroundStyle(TimiColor.paper)
                        .lineLimit(2)
                        .minimumScaleFactor(0.75)
                    if let secondary = maneuver.secondaryText {
                        Text(secondary)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(TimiColor.paper.opacity(0.72))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)

            if !maneuver.lanes.isEmpty {
                TimiLaneGuidanceRow(lanes: maneuver.lanes)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(NavCard(fill: TimiColor.ink))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("In \(TimiNavFormat.distance(meters: maneuver.distanceMeters, units: units)), \(spokenKind). \(maneuver.primaryText)")
        .overlay(alignment: .bottomLeading) {
            if let next {
                TimiNextManeuverChip(next: next)
                    .offset(x: 14, y: 34)
            }
        }
        .padding(.bottom, next == nil ? CGFloat(0) : CGFloat(30))
    }

    private var spokenKind: String {
        switch maneuver.kind {
        case .depart: return "head out"
        case .straight: return "continue straight"
        case .slightLeft: return "bear left"
        case .slightRight: return "bear right"
        case .left: return "turn left"
        case .right: return "turn right"
        case .sharpLeft: return "turn sharply left"
        case .sharpRight: return "turn sharply right"
        case .uTurn: return "make a U-turn"
        case .mergeLeft: return "merge left"
        case .mergeRight: return "merge right"
        case .forkLeft, .keepLeft: return "keep left"
        case .forkRight, .keepRight: return "keep right"
        case .onRampLeft, .onRampRight: return "take the ramp"
        case .offRampLeft: return "take the exit on the left"
        case .offRampRight: return "take the exit"
        case .roundabout, .roundaboutLeft, .roundaboutRight, .roundaboutStraight: return "take the roundabout"
        case .arrive, .arriveLeft, .arriveRight: return "arrive at your destination"
        }
    }
}

/// Lane arrows inside the banner: usable lanes bright, the recommended
/// arrow gold, everything else receded. Conventional lane geometry — only
/// the palette is Tími's.
struct TimiLaneGuidanceRow: View {
    var lanes: [TimiLane]

    var body: some View {
        HStack(spacing: 10) {
            ForEach(lanes) { lane in
                TimiLaneGlyph(
                    lane: lane,
                    activeColor: lane.active != nil ? TimiColor.gold : TimiColor.paper.opacity(0.85),
                    inactiveColor: TimiColor.paper.opacity(lane.isUsable ? Double(0.55) : Double(0.24))
                )
                .frame(width: 30, height: 30)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity)
        .background(NavPalette.inkRaised, in: UnevenRoundedRectangle(bottomLeadingRadius: 16, bottomTrailingRadius: 16))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Lane guidance: use the highlighted lane")
    }
}

/// "Then ⌐" — the maneuver after this one, compact enough to ignore.
struct TimiNextManeuverChip: View {
    var next: TimiNextManeuver

    var body: some View {
        HStack(spacing: 7) {
            Text("then")
                .font(.system(size: 13, weight: .heavy))
                .foregroundStyle(TimiColor.paper.opacity(0.8))
            TimiManeuverGlyph(kind: next.kind, roundaboutExitDegrees: nil, color: TimiColor.gold)
                .frame(width: 20, height: 20)
            Text(next.text)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(TimiColor.paper)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(NavPalette.inkRaised, in: Capsule())
        .overlay(Capsule().stroke(TimiColor.gold.faded(0.7), lineWidth: 1.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Then \(next.text)")
    }
}

// MARK: - Alerts (rerouting, off-route, faster route, errors)

/// The transient state strip under the banner. One state at a time, in
/// plain words. The faster-route case is informational: the SDK's default
/// `fasterRouteApproval` is automatic, so this announces the switch the
/// engine is already making rather than pretending the driver chose it.
struct TimiNavAlertBanner: View {
    var alert: TimiNavAlert

    var body: some View {
        HStack(spacing: 10) {
            switch alert {
            case .offRoute:
                Text("Off route — finding a way back")
                    .font(.system(size: 15, weight: .heavy))
            case .rerouting:
                ProgressView().tint(TimiColor.ink)
                Text("Finding another route…")
                    .font(.system(size: 15, weight: .heavy))
            case .rerouted:
                Text("New route set")
                    .font(.system(size: 15, weight: .heavy))
            case .fasterRouteAvailable:
                Text("Found a faster route — switching")
                    .font(.system(size: 15, weight: .heavy))
            case .gpsUncertain:
                Text("Weak GPS — guidance may lag")
                    .font(.system(size: 15, weight: .heavy))
            case .error(let message):
                Text(message)
                    .font(.system(size: 15, weight: .heavy))
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .foregroundStyle(foreground)
        .modifier(NavCard(fill: fill, radius: 14))
        .accessibilityElement(children: .contain)
    }

    private var isFasterRoute: Bool { if case .fasterRouteAvailable = alert { return true }; return false }

    private var fill: Color {
        switch alert {
        case .offRoute, .error: return TimiColor.coralSoft
        case .rerouting, .gpsUncertain: return TimiColor.goldSoft
        case .rerouted: return Color(red: 0.91, green: 0.97, blue: 0.95)
        case .fasterRouteAvailable: return TimiColor.blueSoft
        }
    }

    private var foreground: Color {
        switch alert {
        case .offRoute, .error: return Color(red: 0.74, green: 0.24, blue: 0.19)
        case .rerouted: return Color(red: 0.06, green: 0.42, blue: 0.27)
        default: return TimiColor.ink
        }
    }
}

// MARK: - Trip status / approach / arrival

/// The bottom card. During ordinary guidance: time remaining first, then
/// distance and ETA, with overview and a guarded End. On approach it hands
/// its space to the clinic — who you are driving to matters more than the
/// arithmetic once the trip is nearly over.
struct TimiTripStatusCard: View {
    @Environment(\.colorScheme) private var scheme
    var trip: TimiTripProgress?
    var phase: TimiNavPhase
    var destination: NavigationDestination
    var units: DistanceUnits
    var onEnd: () -> Void
    @State private var confirmingEnd = false

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            if phase == .approaching {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Almost there")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(TimiColor.coral)
                        .textCase(.uppercase)
                    Text(destination.name)
                        .font(.system(size: 19, weight: .heavy))
                        .foregroundStyle(NavPalette.cardText(scheme))
                        .lineLimit(2)
                        .minimumScaleFactor(0.8)
                    if let trip {
                        Text("\(TimiNavFormat.distance(meters: trip.metersRemaining, units: units)) · arrive \(TimiNavFormat.eta(trip.eta))")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(NavPalette.mutedText(scheme))
                            .monospacedDigit()
                    }
                }
                Spacer(minLength: 8)
                if let phone = destination.phone, let url = URL(string: "tel:\(phone.filter { !$0.isWhitespace })") {
                    Link(destination: url) {
                        Image(systemName: "phone.fill")
                            .font(.system(size: 19, weight: .bold))
                            .frame(width: 52, height: 52)
                            .background(TimiColor.blue, in: Circle())
                            .foregroundStyle(.white)
                            .overlay(Circle().stroke(NavPalette.cardBorder(scheme), lineWidth: 2))
                    }
                    .accessibilityLabel("Call \(destination.name)")
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(trip.map { TimiNavFormat.duration(seconds: $0.secondsRemaining) } ?? "—")
                        .font(.system(size: 30, weight: .heavy, design: .rounded))
                        .foregroundStyle(NavPalette.cardText(scheme))
                        .monospacedDigit()
                    if let trip {
                        Text("\(TimiNavFormat.distance(meters: trip.metersRemaining, units: units)) · \(TimiNavFormat.eta(trip.eta))")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(NavPalette.mutedText(scheme))
                            .monospacedDigit()
                    }
                }
                Spacer(minLength: 8)
            }

            Button {
                confirmingEnd = true
            } label: {
                Text("End")
                    .font(.system(size: 16, weight: .heavy))
                    .padding(.horizontal, 18)
                    .frame(minHeight: 48)
                    .background(TimiColor.coral, in: Capsule())
                    .foregroundStyle(.white)
                    .overlay(Capsule().stroke(NavPalette.cardBorder(scheme), lineWidth: 2))
            }
            .accessibilityLabel("End route")
            .confirmationDialog("End this route?", isPresented: $confirmingEnd, titleVisibility: .visible) {
                Button("End route", role: .destructive) { onEnd() }
                Button("Keep driving", role: .cancel) { }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .frame(maxWidth: .infinity)
        .modifier(NavCard())
        .accessibilityElement(children: .contain)
    }
}

/// The arrival card: the trip is over, the clinic is the whole story.
/// Serif headline — the one place in navigation the editorial voice belongs,
/// because nobody is driving anymore.
struct TimiArrivalCard: View {
    @Environment(\.colorScheme) private var scheme
    var destination: NavigationDestination
    var recordsArrival: Bool
    var onConfirmArrival: () -> Void
    var onEnd: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("You've arrived.")
                .font(.system(size: 30, weight: .bold, design: .serif))
                .foregroundStyle(NavPalette.cardText(scheme))
            VStack(alignment: .leading, spacing: 3) {
                Text(destination.name)
                    .font(.system(size: 18, weight: .heavy))
                    .foregroundStyle(NavPalette.cardText(scheme))
                Text(destination.address)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(NavPalette.mutedText(scheme))
            }
            if let phone = destination.phone, let url = URL(string: "tel:\(phone.filter { !$0.isWhitespace })") {
                Link(destination: url) {
                    Label("Call \(destination.name)", systemImage: "phone.fill")
                        .font(.system(size: 16, weight: .heavy))
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(TimiColor.blue, in: RoundedRectangle(cornerRadius: 14))
                        .foregroundStyle(.white)
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(NavPalette.cardBorder(scheme), lineWidth: 2))
                }
            }
            if recordsArrival {
                Button {
                    onConfirmArrival()
                } label: {
                    Text("Tell the clinic I'm here")
                        .font(.system(size: 16, weight: .heavy))
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(TimiColor.coral, in: RoundedRectangle(cornerRadius: 14))
                        .foregroundStyle(.white)
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(NavPalette.cardBorder(scheme), lineWidth: 2))
                }
            }
            Button("End route") { onEnd() }
                .font(.system(size: 16, weight: .bold))
                .frame(maxWidth: .infinity, minHeight: 48)
                .foregroundStyle(NavPalette.cardText(scheme))
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(NavCard())
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Map controls, speed, road name

/// The floating map controls: exactly two — overview/re-center and voice —
/// because everything else either lives in the trip card or does not earn
/// permanent space over the map.
struct TimiMapControls: View {
    @Environment(\.colorScheme) private var scheme
    var isOverview: Bool
    var isMuted: Bool
    var onToggleOverview: () -> Void
    var onToggleMute: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            control(
                systemImage: isOverview ? "location.fill" : "map",
                label: isOverview ? "Re-center on your route" : "Show route overview",
                action: onToggleOverview
            )
            control(
                systemImage: isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill",
                label: isMuted ? "Unmute voice guidance" : "Mute voice guidance",
                action: onToggleMute
            )
        }
    }

    private func control(systemImage: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .bold))
                .frame(width: 52, height: 52)
                .background(NavPalette.card(scheme), in: Circle())
                .foregroundStyle(NavPalette.cardText(scheme))
                .overlay(Circle().stroke(NavPalette.cardBorder(scheme), lineWidth: 2))
                .shadow(color: TimiColor.ink.opacity(0.3), radius: 0, x: 2, y: 2)
        }
        .accessibilityLabel(label)
    }
}

/// Current speed, with the posted limit beside it as an unmistakable road
/// sign. The sign stays a sign — regulatory information is the one place
/// branding yields completely.
struct TimiSpeedView: View {
    @Environment(\.colorScheme) private var scheme
    var speed: TimiSpeedInfo
    var units: DistanceUnits

    var body: some View {
        HStack(spacing: 8) {
            VStack(spacing: 0) {
                Text("\(TimiNavFormat.speed(metersPerSecond: speed.currentMetersPerSecond, units: units))")
                    .font(.system(size: 22, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(overLimit ? .white : NavPalette.cardText(scheme))
                Text(units == .metric ? "km/h" : "mph")
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(overLimit ? .white.opacity(0.85) : NavPalette.mutedText(scheme))
            }
            .frame(width: 56, height: 56)
            .background(overLimit ? TimiColor.coral : NavPalette.card(scheme), in: Circle())
            .overlay(Circle().stroke(NavPalette.cardBorder(scheme), lineWidth: 2))
            .shadow(color: TimiColor.ink.opacity(0.3), radius: 0, x: 2, y: 2)

            if let limit = speed.limitMetersPerSecond {
                limitSign(TimiNavFormat.speed(metersPerSecond: limit, units: units))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var overLimit: Bool {
        guard let limit = speed.limitMetersPerSecond else { return false }
        return speed.currentMetersPerSecond > limit + 2.2 // ~5 mph of grace
    }

    @ViewBuilder private func limitSign(_ value: Int) -> some View {
        if speed.isMUTCD {
            VStack(spacing: 0) {
                Text("SPEED\nLIMIT")
                    .font(.system(size: 8, weight: .heavy))
                    .multilineTextAlignment(.center)
                Text("\(value)")
                    .font(.system(size: 20, weight: .heavy))
                    .monospacedDigit()
            }
            .foregroundStyle(.black)
            .frame(width: 44, height: 56)
            .background(.white, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.black, lineWidth: 2).padding(3))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(NavPalette.cardBorder(scheme).faded(0.4), lineWidth: 1))
        } else {
            Text("\(value)")
                .font(.system(size: 19, weight: .heavy))
                .monospacedDigit()
                .foregroundStyle(.black)
                .frame(width: 52, height: 52)
                .background(.white, in: Circle())
                .overlay(Circle().stroke(.red, lineWidth: 6).padding(2))
        }
    }

    private var accessibilitySummary: String {
        let unitName = units == .metric ? "kilometers per hour" : "miles per hour"
        var text = "Current speed \(TimiNavFormat.speed(metersPerSecond: speed.currentMetersPerSecond, units: units)) \(unitName)"
        if let limit = speed.limitMetersPerSecond {
            text += ", limit \(TimiNavFormat.speed(metersPerSecond: limit, units: units))"
        }
        return text
    }
}

/// The current road, in a quiet pill at the bottom of the map.
struct TimiRoadNamePill: View {
    var name: String

    var body: some View {
        Text(name)
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(TimiColor.paper)
            .lineLimit(1)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(TimiColor.ink.faded(0.88), in: Capsule())
            .overlay(Capsule().stroke(TimiColor.gold.faded(0.75), lineWidth: 1.5))
            .accessibilityLabel("On \(name)")
    }
}
#endif
