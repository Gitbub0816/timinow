import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

// Turn-by-turn navigation, Tími's own presentation over Mapbox's engine.
//
// Mapbox provides the navigation intelligence — route calculation and
// alternatives, rerouting, map matching and progress, maneuver/instruction/
// lane data, spoken-instruction timing, the navigation camera, the map
// itself with live traffic, and arrival detection. Tími provides the
// experience: every visible panel during a drive is drawn by
// TimiNavigationChrome.swift from the plain models in
// TimiNavigationModel.swift, fed by the publisher adapter in
// TimiNavigationSession.swift. The stock MapboxNavigationUIKit drop-in UI
// (NavigationViewController and its UIAppearance-reskinned banners, which
// this file used to host) is gone from the build entirely — see
// docs/NAVIGATION.md for the architecture and Package.swift for the removed
// product dependency.
//
// Written without a Mac or Xcode, so every Mapbox symbol used below was read
// out of a local clone of mapbox-navigation-ios at v3.27.3 rather than
// remembered (the fuller symbol inventory is at the top of
// TimiNavigationSession.swift). Confirmed there, for this file specifically:
//
//   - `MapboxRoutingProvider` has no public initializer; a provider comes
//     from `MapboxNavigationProvider.routingProvider()`.
//   - `calculateRoutes(options:)` returns `Task<NavigationRoutes, Error>`,
//     awaited through `.value`.
//   - `RouteOptions.roadClassesToAvoid` takes `.toll`/`.motorway`/`.ferry`.
//   - Guidance starts with `tripSession().startActiveGuidance(with:
//     startLegIndex:)` and ends with `setToIdle()` — the session adapter
//     wraps both.
//
// None of that is a substitute for compiling it. Everything Mapbox is
// `canImport` guarded, so a mismatch affects only the Mapbox build path; the
// `#else` fallback below compiles independently and is what default CI and
// the Android/Skip build actually exercise.

#if canImport(MapboxNavigationCore) && canImport(MapboxMaps) && !SKIP && os(iOS)
import MapboxNavigationCore
import MapboxMaps
import MapboxDirections
import CoreLocation
import UIKit

/// Whether turn-by-turn is compiled into this build.
///
/// The two implementations of `TurnByTurnNavigationView` below are chosen by
/// `canImport`, which callers cannot ask about — a `#if` in a view's `body`
/// gets messy fast and cannot be read from `TimiNowCore` at all. This is the
/// same condition, as a value, so a screen can offer our navigation when it
/// exists and Apple Maps when it does not, rather than offering ours and
/// presenting the "not included in this build" card.
public enum TurnByTurn {
    public static let isAvailable = true
}

/// The navigation flow: request a route, then run active guidance under
/// Tími's chrome. Three explicit states — preparing (route being
/// calculated), failed (the honest fallback card), and active (the drive).
struct TurnByTurnNavigationView: View {
    var destination: NavigationDestination
    var origin: GeoPoint
    var preferences: NavigationPreferences
    var navigationStyleURL: String
    var petName: String
    /// Which register to speak in, carried down from the intake's urgency.
    var tone: NavigationTone
    /// Not optional. AppStore holds it as `String?` because it is absent until
    /// /api/config answers, and that optional stops here — one `?? ""` at the
    /// call site, matching ClinicMapView.
    var mapboxAccessToken: String
    /// Whether the arrival card offers "Tell the clinic I'm here" — false for
    /// the emergency list, where there is no confirmed appointment to arrive
    /// at (see NavigationScreen.recordsArrival).
    var recordsArrival: Bool = true
    var onProgress: (NavigationStepModel, RouteSummary) -> Void
    var onArrival: () -> Void
    var onEnd: () -> Void

    @State private var session: TimiNavigationSession?
    @State private var failed = false

    var body: some View {
        ZStack {
            if failed {
                NavigationFallbackCard(destination: destination, onArrival: onArrival, onEnd: onEnd)
            } else if let session {
                TimiActiveNavigationView(
                    session: session,
                    styleURL: navigationStyleURL,
                    units: preferences.distanceUnits,
                    recordsArrival: recordsArrival,
                    onConfirmArrival: onArrival,
                    onEnd: { end(session) }
                )
            } else {
                NavigationPreparingCard(clinicName: destination.name)
            }
        }
        .task { await prepare() }
    }

    /// Route request and guidance start. Each stage is marked before it is
    /// entered — a crash inside a framework cannot be caught in process, so
    /// the only report that survives is one written before it happens
    /// (TimiBreadcrumb; the names are load-bearing, validate-native.mjs
    /// checks them).
    @MainActor
    private func prepare() async {
        TimiBreadcrumb.mark("nav:host_setup")
        // Mapbox is not given an empty access token:
        // NavigationCoreApiConfiguration treats one as a programming error
        // and traps. The token comes from /api/config, so any launch that
        // could not reach the Worker would otherwise arm a crash here.
        guard !mapboxAccessToken.isEmpty else {
            TimiBreadcrumb.clear()
            failed = true
            return
        }
        TimiBreadcrumb.mark("nav:route_request")
        // The route starts where the phone actually is, not where AppStore
        // last heard it was — one fresh fix at Navigate time fixes the drawn
        // polyline; during guidance the SDK follows the real GPS regardless.
        // Falls back to the passed origin when permission is missing or the
        // fix times out.
        let fresh = await PlatformPermissions.currentLocation()
        let originCoordinate = fresh.map { CLLocationCoordinate2D(latitude: $0.0, longitude: $0.1) }
            ?? CLLocationCoordinate2D(latitude: origin.latitude, longitude: origin.longitude)
        let originWaypoint = Waypoint(coordinate: originCoordinate)
        let destinationWaypoint = Waypoint(
            coordinate: CLLocationCoordinate2D(latitude: destination.latitude, longitude: destination.longitude),
            name: destination.name
        )

        // `automobileAvoidingTraffic` is the profile default; naming it keeps
        // the intent explicit, because an emergency drive is exactly the case
        // where live traffic should shape the ETA.
        let options = NavigationRouteOptions(
            waypoints: [originWaypoint, destinationWaypoint],
            profileIdentifier: .automobileAvoidingTraffic
        )
        var avoid: RoadClasses = []
        if preferences.avoidTolls { avoid.insert(.toll) }
        if preferences.avoidHighways { avoid.insert(.motorway) }
        if preferences.avoidFerries { avoid.insert(.ferry) }
        options.roadClassesToAvoid = avoid

        // One provider serves both the route request and the live session, so
        // the credentials and the custom voice configured on it apply to the
        // trip too — see TimiNavigationStack for why there is exactly one.
        TimiBreadcrumb.mark("nav:provider")
        // `shared` first, then `beginTrip` — in that order, and the order is
        // the whole point. `beginTrip` retunes the synthesizer the provider
        // owns, and on the first drive of a launch that synthesizer does not
        // exist until `shared` builds it, so calling `beginTrip` first was a
        // silent no-op: the voice kept the placeholder identity it is
        // constructed with and said "the clinic" and "your pet", in the calm
        // register, on a drive to a named emergency hospital.
        let provider = TimiNavigationStack.shared(mapToken: mapboxAccessToken, preferences: preferences)
        TimiNavigationStack.beginTrip(
            clinicName: destination.name,
            petName: petName,
            clinicKind: destination.kind,
            tone: tone
        )
        do {
            TimiBreadcrumb.mark("nav:calculate_routes")
            let routes = try await provider.routingProvider().calculateRoutes(options: options).value
            TimiBreadcrumb.mark("nav:present")
            let newSession = TimiNavigationSession(
                provider: provider,
                destination: destination,
                units: preferences.distanceUnits,
                onProgressMirror: onProgress,
                onArrival: onArrival
            )
            newSession.start(with: routes)
            if !preferences.voiceEnabled { newSession.setMuted(true) }
            // NOT cleared here. The first custom-UI window — style load,
            // Metal startup, the location engine, the trip session — is
            // exactly where a crash costs the most, and clearing on present
            // would put it in the one window with no name on it. The mark
            // stays until navigation ends: finish, arrival, or fallback.
            TimiBreadcrumb.mark("nav:live")
            session = newSession
        } catch {
            // A route that could not be calculated is a failure, not a
            // crash: the breadcrumb is cleared so the next launch does not
            // report a handled error as one.
            TimiBreadcrumb.clear()
            failed = true
        }
    }

    @MainActor
    private func end(_ session: TimiNavigationSession) {
        session.end()
        TimiBreadcrumb.clear()
        onEnd()
    }
}

/// The whole active-guidance screen: the map underneath, Tími's chrome in
/// two bands — instructions at the top, trip status at the bottom — and
/// nothing else covering the map. Which bottom card shows follows the
/// session's phase; arrival replaces the trip card with the arrival card.
struct TimiActiveNavigationView: View {
    var session: TimiNavigationSession
    var styleURL: String
    var units: DistanceUnits
    var recordsArrival: Bool
    var onConfirmArrival: () -> Void
    var onEnd: () -> Void

    var body: some View {
        ZStack {
            TimiNavigationMapView(session: session, styleURL: styleURL)
                .ignoresSafeArea()

            VStack(spacing: 10) {
                if session.phase != .arrived, let maneuver = session.maneuver {
                    TimiManeuverBanner(maneuver: maneuver, next: session.nextManeuver, units: units)
                }
                if let alert = session.alert {
                    TimiNavAlertBanner(alert: alert)
                }

                Spacer(minLength: 0)

                if session.phase != .arrived {
                    HStack(alignment: .bottom, spacing: 10) {
                        if let speed = session.speed {
                            TimiSpeedView(speed: speed, units: units)
                        }
                        Spacer(minLength: 0)
                        TimiMapControls(
                            isOverview: !session.cameraIsFollowing,
                            isMuted: session.voiceMuted,
                            onToggleOverview: { session.toggleCamera() },
                            onToggleMute: { session.setMuted(!session.voiceMuted) }
                        )
                    }

                    if let road = session.roadName, session.phase == .guiding {
                        TimiRoadNamePill(name: road)
                    }

                    TimiTripStatusCard(
                        trip: session.trip,
                        phase: session.phase,
                        destination: session.destination,
                        units: units,
                        onEnd: onEnd
                    )
                } else {
                    TimiArrivalCard(
                        destination: session.destination,
                        recordsArrival: recordsArrival,
                        onConfirmArrival: onConfirmArrival,
                        onEnd: onEnd
                    )
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 8)
            // The chrome lives inside the safe area even though the map does
            // not: a driving instruction that shares pixels with the system
            // clock is unreadable exactly when it matters.
        }
    }
}

/// The route is being calculated. Its own screen rather than a blank map:
/// the moment between pressing Navigate and the first instruction is where
/// "did it work?" lives.
private struct NavigationPreparingCard: View {
    var clinicName: String

    var body: some View {
        VStack {
            Spacer()
            VStack(spacing: 16) {
                Eyebrow(text: "FINDING YOUR ROUTE")
                Text(clinicName)
                    .font(.title3).fontWeight(.bold)
                    .multilineTextAlignment(.center)
                ProgressView()
                    .controlSize(.large)
                    .tint(TimiColor.blue)
            }
            .padding(24)
            .timiCard(Color.white)
            .padding(20)
            Spacer()
        }
        .background(TimiColor.canvas.ignoresSafeArea())
    }
}

/// What the flow shows when Mapbox has no token or a route could not be
/// calculated. Deliberately a separate type from the non-Mapbox build's own
/// `TurnByTurnNavigationView` (below, in the `#else` branch of this file) —
/// the two are mutually exclusive compile targets, so there is no single
/// shared type to reuse between them.
private struct NavigationFallbackCard: View {
    let destination: NavigationDestination
    let onArrival: () -> Void
    let onEnd: () -> Void

    var body: some View {
        VStack {
            Spacer()
            VStack(spacing: 18) {
                Eyebrow(text: "COULDN'T START IN-APP NAVIGATION")
                Text("Open Maps instead to get directions.").font(.title3).fontWeight(.bold).multilineTextAlignment(.center)
                Text("\(destination.name)\n\(destination.address)").font(.callout).foregroundStyle(TimiColor.muted).multilineTextAlignment(.center)
                if let url = AppleMapsFallback.directionsURL(to: destination) {
                    Link(destination: url) { Label("Open in Maps", systemImage: "map.fill") }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
                }
                Button("I'm here") { onArrival() }.buttonStyle(TimiPrimaryButtonStyle())
                Button("End navigation") { onEnd() }.buttonStyle(TimiQuietButtonStyle())
            }.padding(24).timiCard(Color.white).padding(20)
            Spacer()
        }.background(TimiColor.canvas.ignoresSafeArea())
    }
}

#else

public enum TurnByTurn {
    public static let isAvailable = false
}

/// Non-Mapbox build: keep today's maps.apple.com hand-off. Exercised by
/// default CI (no `TIMI_MAPBOX` / Mapbox token) and by the Android/Skip
/// build.
struct TurnByTurnNavigationView: View {
    var destination: NavigationDestination
    var origin: GeoPoint
    var preferences: NavigationPreferences
    var navigationStyleURL: String
    var petName: String
    var tone: NavigationTone
    var mapboxAccessToken: String
    var recordsArrival: Bool = true
    var onProgress: (NavigationStepModel, RouteSummary) -> Void
    var onArrival: () -> Void
    var onEnd: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            Eyebrow(text: "IN-APP NAVIGATION NOT INCLUDED IN THIS BUILD")
            Text("Turn-by-turn opens in Maps instead.").font(.title3).fontWeight(.bold).multilineTextAlignment(.center)
            Text("\(destination.name)\n\(destination.address)").font(.callout).foregroundStyle(TimiColor.muted).multilineTextAlignment(.center)
            if let url = AppleMapsFallback.directionsURL(to: destination) {
                Link(destination: url) { Label("Open in Maps", systemImage: "map.fill") }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
            }
            Button("I'm here") { onArrival() }.buttonStyle(TimiPrimaryButtonStyle())
            Button("End navigation") { onEnd() }.buttonStyle(TimiQuietButtonStyle())
        }.padding(24).timiCard(Color.white)
    }
}
#endif

/// Shared between both build configurations above.
enum AppleMapsFallback {
    static func directionsURL(to destination: NavigationDestination) -> URL? {
        directionsURL(latitude: destination.latitude, longitude: destination.longitude, name: destination.name)
    }

    /// The coordinate form, for a place that is not a `NavigationDestination`
    /// — an emergency POI with no coordinates, which cannot be navigated to
    /// but can still be looked up by name. There was a second copy of this URL
    /// in `Components.swift`; two Apple Maps links that are meant to behave
    /// identically only stay identical while somebody remembers both.
    static func directionsURL(latitude: Double, longitude: Double, name: String) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = [
            URLQueryItem(name: "daddr", value: "\(latitude),\(longitude)"),
            URLQueryItem(name: "q", value: name)
        ]
        return components?.url
    }
}

/// Full-screen navigation flow shared by both build configurations: hosts
/// `TurnByTurnNavigationView`, records the `arrived` milestone through the
/// existing `AppStore.record(_:)` path, mirrors live progress into
/// `AppStore` for the Watch app, and offers "I'm here" / "End navigation".
struct NavigationScreen: View {
    @Bindable var store: AppStore
    var destination: NavigationDestination
    /// Overrides the tone taken from the care draft. The emergency list has no
    /// draft behind it — somebody can reach it from the hero screen without
    /// having started a search at all — so it passes `.emergency` rather than
    /// letting an empty draft's default urgency pick a calm voice for a drive
    /// to an emergency hospital.
    var tone: NavigationTone?
    /// Whether arriving here means arriving at the confirmed clinic.
    ///
    /// False for the emergency list. `record("arrived")` writes against
    /// `currentIntake`, and somebody with a confirmed appointment at one clinic
    /// who then drives to an emergency hospital would otherwise mark that
    /// appointment arrived — the clinic would be told to expect a patient who
    /// is on the way somewhere else.
    var recordsArrival: Bool = true
    /// Dismisses whatever presented this. Ending navigation used to clear
    /// `store.navigationDestination` and nothing else, which is not what the
    /// full-screen cover is bound to, so the screen stayed up.
    var onFinish: () -> Void = { }
    @State var arrivedPromptShown = false

    var body: some View {
        ZStack(alignment: .bottom) {
            TurnByTurnNavigationView(
                destination: destination,
                origin: GeoPoint(latitude: store.currentLatitude, longitude: store.currentLongitude),
                preferences: store.navigationPreferences,
                navigationStyleURL: store.navigationStyleURL,
                petName: store.selectedPet.name,
                tone: tone ?? NavigationTone.forUrgency(store.draft.urgency),
                mapboxAccessToken: store.mapToken ?? "",
                recordsArrival: recordsArrival,
                onProgress: { step, summary in store.updateNavigationProgress(step: step, summary: summary) },
                onArrival: {
                    arrivedPromptShown = true
                    if recordsArrival { Task { await store.record("arrived") } }
                },
                onEnd: { finish() }
            )
            // Deliberately NOT `.ignoresSafeArea()` here. It reads as "let the
            // map fill the screen", and it does — but it applies to the whole
            // navigation view, chrome included, so the instruction banner ran
            // under the status bar (the clock and battery sat on top of the
            // street name) and the trip card's distance line was cut off by
            // the home indicator. The map ignores the safe area on its own,
            // one level down in TimiActiveNavigationView, which is the only
            // part that should.

            // With the Mapbox build, arrival gets its own card inside the
            // navigation view (TimiArrivalCard); this overlay is the
            // fallback build's arrival prompt only.
            if arrivedPromptShown && !TurnByTurn.isAvailable {
                HStack(spacing: 12) {
                    Button("I'm here") { if recordsArrival { Task { await store.record("arrived") } } else { finish() } }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
                    Button("End navigation") { finish() }.buttonStyle(TimiQuietButtonStyle())
                }.padding(16).background(.white, in: RoundedRectangle(cornerRadius: 20)).padding()
            }
        }
        .onAppear { store.beginNavigation(to: destination) }
    }

    private func finish() {
        TimiBreadcrumb.clear()
        store.navigationDestination = nil
        store.updateNavigationProgress(step: nil, summary: nil)
        onFinish()
    }
}
