#if canImport(MapboxNavigationCore) && canImport(MapboxMaps) && !SKIP && os(iOS)
import Combine
import CoreLocation
import MapboxDirections
import MapboxMaps
import MapboxNavigationCore
import SwiftUI
import TimiNowCore
import UIKit

// The adapter between Mapbox's navigation engine and Tími's own chrome.
// Everything Mapbox stays on this side of the seam: the session below turns
// the SDK's Combine publishers into the plain models in
// TimiNavigationModel.swift, and TimiNavigationChrome.swift never sees a
// Mapbox type. Like NavigationView.swift, this file was written without a
// Mac, so every symbol it touches was read out of a local clone of
// mapbox-navigation-ios at v3.27.3 rather than remembered. Confirmed there:
//
//   - `NavigationController` (MapboxNavigation/NavigationController.swift)
//     posts `routeProgress: AnyPublisher<RouteProgressState?, Never>`,
//     `locationMatching: AnyPublisher<MapMatchingState, Never>`,
//     `bannerInstructions: AnyPublisher<VisualInstructionState, Never>`,
//     `waypointsArrival`, `rerouting`, `fasterRoutes`, and `errors`.
//   - The status structs wrap type-erased events (`status.event is
//     ReroutingStatus.Events.FetchingRoute` and friends) — Navigator.swift.
//   - `SessionController.startActiveGuidance(with:startLegIndex:)` starts
//     guidance; `setToIdle()` ends it; `session` posts `Session` whose
//     `.activeGuidance(state)` carries offRoute/uncertain/tracking/complete.
//   - `MapMatchingState.currentSpeed` is a `Measurement<UnitSpeed>`,
//     `.speedLimit` is `SpeedLimit(value:signStandard:)`, `.roadName` is
//     an optional `RoadName` with `.text`.
//   - `NavigationMapView.init(location:routeProgress:routeRefreshing:...)`
//     subscribes itself to progress and draws/refreshes/vanishes the route
//     line on its own (subscribeToRouteProgressUpdates) — no manual `show`.
//   - `congestionConfiguration.colors` takes a `CongestionColorsConfiguration`
//     of two `Colors{low,moderate,heavy,severe,unknown}` sets; the traversed
//     line is `traversedRouteColor`; the maneuver arrow `maneuverArrowColor`.
//   - `RouteVoiceController` is self-driving: constructing it (the provider's
//     lazy `routeVoiceController`) subscribes it to voice instructions, and
//     its `speechSynthesizer.muted` is the supported mute switch.
//   - Faster routes auto-apply: `CoreConfig.fasterRouteDetectionConfig`
//     defaults `fasterRouteApproval` to `.automatically`, so `Detected` /
//     `Applied` are informational — which is why `TimiNavAlertBanner` has no
//     "Switch" button to wire here.
//
// None of that is a substitute for compiling it: this path only builds with
// TIMI_MAPBOX set, which CI does not have. `bash scripts/build-ios-app.sh`
// on a Mac is the real gate for this file.

/// Observable state for one drive, fed by the engine's publishers, read by
/// the SwiftUI chrome. Owns no Mapbox objects beyond subscriptions — the
/// provider is the app-wide `TimiNavigationStack` singleton.
@MainActor
@Observable
final class TimiNavigationSession {
    private(set) var phase: TimiNavPhase = .preparing
    private(set) var maneuver: TimiManeuver?
    private(set) var nextManeuver: TimiNextManeuver?
    private(set) var trip: TimiTripProgress?
    private(set) var speed: TimiSpeedInfo?
    private(set) var roadName: String?
    private(set) var alert: TimiNavAlert?
    /// Whether the camera is in following mode; toggled by the overview
    /// button, reset by the SDK when the user pans (the map view reports
    /// camera-state changes back through `syncCameraState`).
    private(set) var cameraFollowing = true
    /// Mirrors the synthesizer's mute here because `@Observable` tracks
    /// stored properties only — a computed passthrough to
    /// `TimiNavigationStack` would mute correctly and never re-render the
    /// button.
    private(set) var voiceMuted = false

    let destination: NavigationDestination
    private let provider: MapboxNavigationProvider
    private let units: DistanceUnits
    private let onProgressMirror: (NavigationStepModel, RouteSummary) -> Void
    private let onArrival: () -> Void
    private var subscriptions = Set<AnyCancellable>()
    private var lastMirror = Date.distantPast
    private var alertClearTask: Task<Void, Never>?

    /// Distance from the destination at which the trip card gives way to the
    /// clinic card. Matches the voice synthesizer's own "look for the
    /// entrance" window (VoiceController.swift) so the screen and the voice
    /// change register together.
    private static let approachWindowMeters: CLLocationDistance = 400

    init(
        provider: MapboxNavigationProvider,
        destination: NavigationDestination,
        units: DistanceUnits,
        onProgressMirror: @escaping (NavigationStepModel, RouteSummary) -> Void,
        onArrival: @escaping () -> Void
    ) {
        self.provider = provider
        self.destination = destination
        self.units = units
        self.onProgressMirror = onProgressMirror
        self.onArrival = onArrival
    }

    /// The engine's event surface, used by the map representable too.
    var navigation: NavigationController { provider.mapboxNavigation.navigation() }

    /// Begins active guidance and wires every publisher this screen draws
    /// from. Called once, after routes are calculated.
    func start(with routes: NavigationRoutes) {
        subscribe()
        // Touching `routeVoiceController` constructs it, and construction is
        // the subscription: the voice controller drives itself off the
        // navigator's voice instructions from here on (RouteVoiceController
        // subscribes in its initializer). Without this line there is no
        // spoken guidance at all — the stock NavigationViewController used to
        // be the thing that touched it.
        _ = provider.routeVoiceController
        provider.mapboxNavigation.tripSession().startActiveGuidance(with: routes, startLegIndex: 0)
        phase = .guiding
    }

    /// Ends guidance. The caller decides what the screen does next.
    func end() {
        subscriptions.removeAll()
        alertClearTask?.cancel()
        provider.mapboxNavigation.tripSession().setToIdle()
    }

    /// The overview/re-center toggle. The map representable reads
    /// `cameraFollowing` and pushes the state into `NavigationCamera`.
    func toggleOverview() { cameraFollowing.toggle() }

    func setMuted(_ muted: Bool) {
        voiceMuted = muted
        TimiNavigationStack.setVoiceMuted(muted)
    }

    /// Called by the map view when the SDK's camera leaves or re-enters
    /// following (a pan gesture idles the camera without asking us).
    func syncCameraState(following: Bool) { cameraFollowing = following }

    // MARK: - Publisher wiring

    private func subscribe() {
        let navigation = self.navigation

        navigation.routeProgress
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in self?.applyProgress(state?.routeProgress) }
            .store(in: &subscriptions)

        navigation.bannerInstructions
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in self?.applyBanner(state.visualInstruction) }
            .store(in: &subscriptions)

        navigation.locationMatching
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in self?.applyMatching(state) }
            .store(in: &subscriptions)

        provider.mapboxNavigation.tripSession().session
            .receive(on: DispatchQueue.main)
            .sink { [weak self] session in self?.applySession(session) }
            .store(in: &subscriptions)

        navigation.rerouting
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in self?.applyRerouting(status) }
            .store(in: &subscriptions)

        navigation.fasterRoutes
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                // Faster routes apply themselves (fasterRouteApproval defaults
                // to .automatically), so both Detected and Applied mean the
                // same thing to the driver: the line is about to improve.
                if status.event is FasterRoutesStatus.Events.Applied {
                    self?.showTransientAlert(.fasterRouteAvailable, for: 5)
                }
            }
            .store(in: &subscriptions)

        navigation.waypointsArrival
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                guard let self, status.event is WaypointArrivalStatus.Events.ToFinalDestination else { return }
                guard phase != .arrived else { return }
                phase = .arrived
                TimiBreadcrumb.clear()
                onArrival()
            }
            .store(in: &subscriptions)

        navigation.errors
            .receive(on: DispatchQueue.main)
            .sink { [weak self] error in
                // Most NavigatorErrors are recoverable internals the driver
                // cannot act on. The two that leave the trip broken get said
                // out loud; the reroute-failure case is also reported through
                // `rerouting` and lands in the same banner.
                if error is NavigatorErrors.FailedToSetRoute {
                    self?.alert = .error("Couldn't start guidance. Check your connection and try again.")
                }
            }
            .store(in: &subscriptions)
    }

    private func applyProgress(_ progress: RouteProgress?) {
        guard let progress else { return }
        trip = TimiTripProgress(
            secondsRemaining: progress.durationRemaining,
            metersRemaining: progress.distanceRemaining,
            eta: Date(timeIntervalSinceNow: progress.durationRemaining)
        )
        // The banner's countdown. Banner *content* changes only on new
        // instructions; the distance ticks with every progress update.
        if var current = maneuver {
            current.distanceMeters = progress.currentLegProgress.currentStepProgress.distanceRemaining
            maneuver = current
        }
        if phase == .guiding, progress.isFinalLeg, progress.distanceRemaining < Self.approachWindowMeters {
            phase = .approaching
        }
        // Mirror into AppStore (Watch app, live activity) at 1 Hz, not at the
        // rate the navigator publishes.
        let now = Date()
        if now.timeIntervalSince(lastMirror) >= 1 {
            lastMirror = now
            let leg = progress.currentLegProgress
            onProgressMirror(
                NavigationStepModel(
                    instruction: leg.currentStep.instructions,
                    distanceMeters: leg.currentStepProgress.distanceRemaining,
                    maneuver: "\(leg.currentStep.maneuverType)"
                ),
                RouteSummary(distanceMeters: progress.distanceRemaining, expectedTravelSeconds: progress.durationRemaining)
            )
        }
    }

    private func applyBanner(_ banner: VisualInstructionBanner) {
        let primary = banner.primaryInstruction
        let kind = TimiManeuverMapping.kind(
            type: primary.maneuverType,
            direction: primary.maneuverDirection
        )
        maneuver = TimiManeuver(
            kind: kind,
            distanceMeters: maneuver?.distanceMeters ?? banner.distanceAlongStep,
            primaryText: primary.text ?? "",
            secondaryText: banner.secondaryInstruction?.text,
            roundaboutExitDegrees: primary.finalHeading,
            lanes: TimiManeuverMapping.lanes(from: banner.quaternaryInstruction)
        )
        if let tertiary = banner.tertiaryInstruction, let text = tertiary.text, !text.isEmpty {
            nextManeuver = TimiNextManeuver(
                kind: TimiManeuverMapping.kind(type: tertiary.maneuverType, direction: tertiary.maneuverDirection),
                text: text
            )
        } else {
            nextManeuver = nil
        }
    }

    private func applyMatching(_ state: MapMatchingState) {
        speed = TimiSpeedInfo(
            currentMetersPerSecond: state.currentSpeed.converted(to: .metersPerSecond).value,
            limitMetersPerSecond: state.speedLimit.value?.converted(to: .metersPerSecond).value,
            isMUTCD: state.speedLimit.signStandard == .mutcd
        )
        let name = state.roadName?.text ?? ""
        roadName = name.isEmpty ? nil : name
    }

    private func applySession(_ session: Session) {
        guard case .activeGuidance(let state) = session.state else { return }
        switch state {
        case .offRoute:
            // Rerouting usually follows within a beat; don't flash "off route"
            // over a banner already saying "finding a new way".
            if alert != .rerouting { alert = .offRoute }
        case .uncertain:
            if alert == nil { alert = .gpsUncertain }
        case .tracking:
            if alert == .offRoute || alert == .gpsUncertain { alert = nil }
        case .initialized, .complete:
            break
        }
    }

    private func applyRerouting(_ status: ReroutingStatus) {
        switch status.event {
        case is ReroutingStatus.Events.FetchingRoute:
            alert = .rerouting
        case is ReroutingStatus.Events.Fetched:
            showTransientAlert(.rerouted, for: 4)
        case is ReroutingStatus.Events.Failed:
            alert = .error("Couldn't find a new route. Guidance may be off until GPS recovers.")
        case is ReroutingStatus.Events.Interrupted:
            if alert == .rerouting { alert = nil }
        default:
            break
        }
    }

    /// Shows an alert that names a moment rather than a condition, and clears
    /// itself — unless a real condition replaced it in the meantime.
    private func showTransientAlert(_ transient: TimiNavAlert, for seconds: Double) {
        alert = transient
        alertClearTask?.cancel()
        alertClearTask = Task { [weak self] in
            _ = try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            if alert == transient { alert = nil }
        }
    }
}

// MARK: - Maneuver vocabulary mapping

/// Translates MapboxDirections' maneuver vocabulary into the glyph system's.
/// Total over both enums: an unrecognized pairing degrades to `.straight`,
/// never to a blank banner.
enum TimiManeuverMapping {
    static func kind(type: ManeuverType?, direction: ManeuverDirection?) -> TimiManeuverKind {
        switch type {
        case .depart:
            return .depart
        case .arrive:
            switch direction {
            case .left, .slightLeft, .sharpLeft: return .arriveLeft
            case .right, .slightRight, .sharpRight: return .arriveRight
            default: return .arrive
            }
        case .merge:
            return leftish(direction) ? .mergeLeft : .mergeRight
        case .takeOnRamp:
            return leftish(direction) ? .onRampLeft : .onRampRight
        case .takeOffRamp:
            return leftish(direction) ? .offRampLeft : .offRampRight
        case .reachFork:
            return leftish(direction) ? .forkLeft : .forkRight
        case .takeRoundabout, .takeRotary, .turnAtRoundabout, .exitRoundabout, .exitRotary:
            // The banner glyph rotates its exit arm by `finalHeading`; these
            // fixed cases are for surfaces with no heading (lane arrows).
            switch direction {
            case .left, .slightLeft, .sharpLeft: return .roundaboutLeft
            case .right, .slightRight, .sharpRight: return .roundaboutRight
            case .straightAhead: return .roundaboutStraight
            default: return .roundabout
            }
        case .turn, .continue, .passNameChange, .reachEnd, .useLane, .heedWarning, nil:
            switch direction {
            case .sharpLeft: return .sharpLeft
            case .left: return .left
            case .slightLeft: return type == .reachEnd || type == .reachFork ? .keepLeft : .slightLeft
            case .sharpRight: return .sharpRight
            case .right: return .right
            case .slightRight: return type == .reachEnd || type == .reachFork ? .keepRight : .slightRight
            case .uTurn: return .uTurn
            case .straightAhead, .undefined, nil: return .straight
            @unknown default: return .straight
            }
        @unknown default:
            return .straight
        }
    }

    private static func leftish(_ direction: ManeuverDirection?) -> Bool {
        switch direction {
        case .left, .slightLeft, .sharpLeft: return true
        default: return false
        }
    }

    /// Lane guidance from the banner's quaternary instruction. Empty when the
    /// SDK supplies none — the chrome hides the row entirely.
    static func lanes(from instruction: VisualInstruction?) -> [TimiLane] {
        guard let instruction else { return [] }
        var lanes: [TimiLane] = []
        for component in instruction.components {
            guard case .lane(let indications, let isUsable, let preferredDirection) = component else { continue }
            let arrows = arrowKinds(for: indications)
            guard !arrows.isEmpty else { continue }
            let active: TimiManeuverKind? = if isUsable {
                preferredDirection.flatMap { laneKind(for: $0) } ?? (arrows.count == 1 ? arrows[0] : nil)
            } else {
                nil
            }
            lanes.append(TimiLane(id: lanes.count, arrows: arrows, isUsable: isUsable, active: active))
        }
        return lanes
    }

    /// Decomposes the `LaneIndication` OptionSet in left-to-right reading
    /// order — the order the arrows are painted on the pavement.
    private static func arrowKinds(for indications: LaneIndication) -> [TimiManeuverKind] {
        var arrows: [TimiManeuverKind] = []
        if indications.contains(.uTurn) { arrows.append(.uTurn) }
        if indications.contains(.sharpLeft) { arrows.append(.sharpLeft) }
        if indications.contains(.left) { arrows.append(.left) }
        if indications.contains(.slightLeft) { arrows.append(.slightLeft) }
        if indications.contains(.straightAhead) { arrows.append(.straight) }
        if indications.contains(.slightRight) { arrows.append(.slightRight) }
        if indications.contains(.right) { arrows.append(.right) }
        if indications.contains(.sharpRight) { arrows.append(.sharpRight) }
        return arrows
    }

    private static func laneKind(for direction: ManeuverDirection) -> TimiManeuverKind? {
        switch direction {
        case .sharpLeft: return .sharpLeft
        case .left: return .left
        case .slightLeft: return .slightLeft
        case .straightAhead: return .straight
        case .slightRight: return .slightRight
        case .right: return .right
        case .sharpRight: return .sharpRight
        case .uTurn: return .uTurn
        case .undefined: return nil
        @unknown default: return nil
        }
    }
}

// MARK: - The map, Tími-dressed

/// `NavigationMapView` wrapped for SwiftUI, with the route line, puck, and
/// congestion palette translated into Tími's colors — through the SDK's own
/// styling properties, not layer surgery. The map keeps the app's one custom
/// style (docs/PLATFORM-CONTRACT.md: "One style everywhere").
struct TimiNavigationMapView: UIViewRepresentable {
    var session: TimiNavigationSession
    var styleURL: String

    func makeUIView(context: Context) -> NavigationMapView {
        let navigation = session.navigation
        let mapView = NavigationMapView(
            location: navigation.locationMatching.map(\.enhancedLocation).eraseToAnyPublisher(),
            routeProgress: navigation.routeProgress.map(\.?.routeProgress).eraseToAnyPublisher(),
            routeRefreshing: navigation.routeRefreshing
        )

        // The app's one style. The SDK's style manager re-adds its route
        // layers whenever a style finishes loading, so swapping the URI is
        // safe (NavigationMapStyleManager.onStyleLoaded).
        if let url = URL(string: styleURL) {
            mapView.mapView.mapboxMap.styleURI = StyleURI(url: url)
        }

        // Route line: cobalt when traffic is unknown or light, gold and coral
        // as it thickens — the palette's own escalation order, at road-sign
        // saturation so the line stays legible over the custom style. The
        // alternative stays in muted ink-blues so the chosen line is never
        // ambiguous. Traveled route fades to a gray that reads as "spent".
        let main = CongestionColorsConfiguration.Colors(
            low: TimiNavMapPalette.blue,
            moderate: TimiNavMapPalette.gold,
            heavy: TimiNavMapPalette.coral,
            severe: TimiNavMapPalette.coralDark,
            unknown: TimiNavMapPalette.blue
        )
        let alternative = CongestionColorsConfiguration.Colors(
            low: TimiNavMapPalette.altGray,
            moderate: TimiNavMapPalette.altGray,
            heavy: TimiNavMapPalette.altGrayHeavy,
            severe: TimiNavMapPalette.altGrayHeavy,
            unknown: TimiNavMapPalette.altGray
        )
        mapView.congestionConfiguration.colors = CongestionColorsConfiguration(
            mainRouteColors: main,
            alternativeRouteColors: alternative
        )
        mapView.traversedRouteColor = TimiNavMapPalette.traversed
        mapView.maneuverArrowColor = TimiNavMapPalette.ink
        mapView.routeLineTracksTraversal = true
        mapView.showsAlternatives = true

        // The course indicator: Tími's ink-ringed cobalt chevron in place of
        // the stock blue puck. The layout copies the SDK's own
        // `Puck2DConfiguration.navigationDefault` (PuckConfigurations.swift
        // in the v3.27.3 clone): the rotating arrow goes in `bearingImage` —
        // the layer MapboxMaps turns with the course — and `topImage` is a
        // clear 1×1 so nothing screen-aligned sits on top of it.
        mapView.puckType = .puck2D(Puck2DConfiguration(
            topImage: TimiNavMapPalette.clearPixel(),
            bearingImage: TimiNavMapPalette.courseIndicator(),
            showsAccuracyRing: false,
            opacity: 1
        ))
        mapView.puckBearing = .course

        // Keep the maneuver zone clear of Tími's own chrome: banner up top,
        // trip card below.
        mapView.viewportPadding = UIEdgeInsets(top: 180, left: 24, bottom: 220, right: 24)

        mapView.update(navigationCameraState: .following)
        context.coordinator.observeCamera(of: mapView, session: session)
        return mapView
    }

    func updateUIView(_ mapView: NavigationMapView, context: Context) {
        let wantsFollowing = session.cameraFollowing
        let current = mapView.navigationCamera.currentCameraState
        if wantsFollowing, current != .following {
            mapView.update(navigationCameraState: .following)
        } else if !wantsFollowing, current == .following {
            mapView.update(navigationCameraState: .overview)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator {
        private var subscription: AnyCancellable?

        /// Mirrors the SDK's camera state back into the session so a pan
        /// gesture (which idles the camera inside the SDK) flips the
        /// re-center button without us guessing.
        func observeCamera(of mapView: NavigationMapView, session: TimiNavigationSession) {
            subscription = mapView.navigationCamera.cameraStates
                .receive(on: DispatchQueue.main)
                .sink { [weak session] state in
                    session?.syncCameraState(following: state == .following)
                }
        }
    }
}

/// UIKit colors for the map layer — same literals as `TimiColor`
/// (Components.swift), kept as `UIColor` because the SDK's styling
/// properties are UIKit and converting through SwiftUI `Color` resolves
/// against a trait collection the map does not carry.
enum TimiNavMapPalette {
    static let ink = UIColor(red: 17 / 255, green: 27 / 255, blue: 59 / 255, alpha: 1)
    static let blue = UIColor(red: 35 / 255, green: 87 / 255, blue: 217 / 255, alpha: 1)
    static let gold = UIColor(red: 224 / 255, green: 168 / 255, blue: 22 / 255, alpha: 1)
    static let coral = UIColor(red: 242 / 255, green: 95 / 255, blue: 76 / 255, alpha: 1)
    static let coralDark = UIColor(red: 193 / 255, green: 54 / 255, blue: 36 / 255, alpha: 1)
    static let altGray = UIColor(red: 138 / 255, green: 148 / 255, blue: 178 / 255, alpha: 1)
    static let altGrayHeavy = UIColor(red: 108 / 255, green: 116 / 255, blue: 142 / 255, alpha: 1)
    static let traversed = UIColor(red: 176 / 255, green: 182 / 255, blue: 198 / 255, alpha: 0.75)

    /// A transparent 1×1 for the puck's non-rotating layer, standing in for
    /// the SDK's internal `UIColor.clear.image(_:)` helper.
    static func clearPixel() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { _ in }
    }

    /// The course chevron: a cobalt disc with a 2px ink ring (the app's card
    /// border, shrunk to a puck) and a white arrow-tip cut into the top —
    /// restrained on purpose. A paw print rotates ambiguously; a chevron
    /// does not.
    static func courseIndicator() -> UIImage {
        let size = CGSize(width: 44, height: 44)
        return UIGraphicsImageRenderer(size: size).image { context in
            let cg = context.cgContext
            let circle = CGRect(x: 4, y: 4, width: 36, height: 36)
            // Soft white halo so the puck separates from any road color.
            cg.setFillColor(UIColor.white.cgColor)
            cg.fillEllipse(in: circle.insetBy(dx: -3, dy: -3))
            cg.setFillColor(blue.cgColor)
            cg.fillEllipse(in: circle)
            cg.setStrokeColor(ink.cgColor)
            cg.setLineWidth(2)
            cg.strokeEllipse(in: circle.insetBy(dx: 1, dy: 1))
            // The heading wedge.
            cg.setFillColor(UIColor.white.cgColor)
            cg.move(to: CGPoint(x: 22, y: 9))
            cg.addLine(to: CGPoint(x: 30, y: 26))
            cg.addLine(to: CGPoint(x: 22, y: 21))
            cg.addLine(to: CGPoint(x: 14, y: 26))
            cg.closePath()
            cg.fillPath()
        }
    }
}
#endif
