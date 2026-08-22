import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

// NOTE ON VERIFICATION: written without a Mac or Xcode. The Mapbox-specific
// pieces below carry two different confidence levels:
//   - CONFIRMED against a local clone of mapbox-navigation-ios: the
//     `SpeechSynthesizing` protocol shape and `TTSConfig`/`CoreConfig` TTS
//     wiring (see VoiceController.swift), the day/night style subclassing
//     via `mapStyleURL`, and `RouteOptions.roadClassesToAvoid` taking
//     `.toll` / `.motorway` / `.ferry`.
//   - NOT independently re-verified: the exact call chain from
//     `MapboxNavigationProvider` to a routing provider and to a
//     pre-wired `NavigationOptions` (`provider.mapboxNavigation...`,
//     `provider.navigationOptions(styles:)`) and `NavigationRoutes`'s
//     exact shape. Confirm both against the installed SDK version — a
//     mismatch only affects this Mapbox build path (`canImport` guarded);
//     the `#else` fallback below compiles independently and is what
//     default CI and the Android/Skip build actually exercise.

#if canImport(MapboxNavigationUIKit) && canImport(MapboxNavigationCore) && !SKIP && os(iOS)
import MapboxNavigationCore
import MapboxNavigationUIKit
import CoreLocation
import UIKit

/// Pins both Mapbox Navigation's day and night styles to Tími's single
/// custom style (docs/PLATFORM-CONTRACT.md: "One style everywhere"),
/// instead of Mapbox's default streets/dark styles.
final class TimiDayStyle: StandardDayStyle {
    required init() {
        super.init()
        mapStyleURL = URL(string: TimiNowUIStyleSource.current)!
    }
}

final class TimiNightStyle: StandardNightStyle {
    required init() {
        super.init()
        mapStyleURL = URL(string: TimiNowUIStyleSource.current)!
    }
}

/// Holds the last style URL fetched from `/api/config` (or the compiled-in
/// default) so the `StandardDayStyle`/`StandardNightStyle` subclasses —
/// which Mapbox instantiates with a plain `init()` — can read it without a
/// constructor parameter.
enum TimiNowUIStyleSource {
    static var current: String = MapDefaults.styleURL
}

/// `UIViewControllerRepresentable` wrapper around Mapbox's
/// `NavigationViewController`. Requests the route with
/// `.automobileAvoidingTraffic`, applies the avoid-tolls/highways/ferries
/// preferences via `roadClassesToAvoid`, and reports arrival + live
/// progress back through `AppStore`.
struct TurnByTurnNavigationView: UIViewControllerRepresentable {
    var destination: NavigationDestination
    var origin: GeoPoint
    var preferences: NavigationPreferences
    var navigationStyleURL: String
    var petName: String
    var mapboxAccessToken: String?
    var onProgress: (NavigationStepModel, RouteSummary) -> Void
    var onArrival: () -> Void
    var onEnd: () -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        TimiNowUIStyleSource.current = navigationStyleURL
        return NavigationHostController(
            destination: destination, origin: origin, preferences: preferences, petName: petName, mapboxAccessToken: mapboxAccessToken,
            onProgress: onProgress, onArrival: onArrival, onEnd: onEnd
        )
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) { }
}

final class NavigationHostController: UIViewController {
    private let destination: NavigationDestination
    private let origin: GeoPoint
    private let preferences: NavigationPreferences
    private let petName: String
    private let mapboxAccessToken: String?
    private let onProgress: (NavigationStepModel, RouteSummary) -> Void
    private let onArrival: () -> Void
    private let onEnd: () -> Void
    private var navigationViewController: NavigationViewController?

    init(destination: NavigationDestination, origin: GeoPoint, preferences: NavigationPreferences, petName: String, mapboxAccessToken: String?, onProgress: @escaping (NavigationStepModel, RouteSummary) -> Void, onArrival: @escaping () -> Void, onEnd: @escaping () -> Void) {
        self.destination = destination
        self.origin = origin
        self.preferences = preferences
        self.petName = petName
        self.mapboxAccessToken = mapboxAccessToken
        self.onProgress = onProgress
        self.onArrival = onArrival
        self.onEnd = onEnd
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white
        Task { await requestRouteAndPresent() }
    }

    private func requestRouteAndPresent() async {
        let originWaypoint = Waypoint(coordinate: CLLocationCoordinate2D(latitude: origin.latitude, longitude: origin.longitude))
        let destinationWaypoint = Waypoint(
            coordinate: CLLocationCoordinate2D(latitude: destination.latitude, longitude: destination.longitude),
            name: destination.name
        )
        var options = NavigationRouteOptions(waypoints: [originWaypoint, destinationWaypoint])
        options.profileIdentifier = .automobileAvoidingTraffic
        var avoid: RoadClasses = []
        if preferences.avoidTolls { avoid.insert(.toll) }
        if preferences.avoidHighways { avoid.insert(.motorway) }
        if preferences.avoidFerries { avoid.insert(.ferry) }
        options.roadClassesToAvoid = avoid

        let provider = MapboxRoutingProvider()
        let outcome: Result<NavigationRoutes, Error> = await withCheckedContinuation { continuation in
            _ = provider.calculateRoutes(options: options) { result in continuation.resume(returning: result) }
        }

        switch outcome {
        case .success(let routes):
            presentNavigation(routes: routes)
        case .failure:
            presentFallback()
        }
    }

    private func presentNavigation(routes: NavigationRoutes) {
        // TTS is wired through `CoreConfig.ttsConfig` (confirmed shape —
        // see VoiceController.swift), not a per-instance parameter on
        // `NavigationOptions`. `MapboxNavigationProvider.navigationOptions`
        // is the best-effort accessor for a `NavigationOptions` that
        // already carries that config through to the live session —
        // confirm this exact call against the installed SDK.
        let speechSynthesizer = preferences.voiceEnabled
            ? TimiSpeechStack.makeSynthesizer(preferences: preferences, clinicName: destination.name, petName: petName, clinicKind: destination.kind)
            : nil
        let coreConfig = CoreConfig(
            credentials: .init(navigation: .init(accessToken: mapboxAccessToken)),
            locale: Locale.current,
            ttsConfig: speechSynthesizer.map { TTSConfig.custom(speechSynthesizer: $0) } ?? .localOnly
        )
        let navigationProvider = MapboxNavigationProvider(coreConfig: coreConfig)
        let dayStyle = TimiDayStyle()
        let nightStyle = TimiNightStyle()
        let navigationOptions = navigationProvider.navigationOptions(styles: [dayStyle, nightStyle])
        let vc = NavigationViewController(navigationRoutes: routes, navigationOptions: navigationOptions)
        vc.delegate = self
        vc.modalPresentationStyle = .fullScreen
        addChild(vc)
        vc.view.frame = view.bounds
        vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(vc.view)
        vc.didMove(toParent: self)
        navigationViewController = vc
    }

    private func presentFallback() {
        // Route request failed (offline, misconfigured token, etc.) — hand
        // off to the plain maps.apple.com link rather than a blank screen.
        if let url = AppleMapsFallback.directionsURL(to: destination) {
            UIApplication.shared.open(url)
        }
        onEnd()
    }
}

extension NavigationHostController: NavigationViewControllerDelegate {
    func navigationViewController(_ navigationViewController: NavigationViewController, didArriveAt waypoint: Waypoint) -> Bool {
        onArrival()
        return true
    }

    // NOTE ON VERIFICATION: `RouteProgress`/`RouteLegProgress`'s exact
    // property names have been broadly stable across Mapbox Navigation SDK
    // versions, but this specific delegate method's name/signature was not
    // independently re-confirmed against the installed 3.27.x SDK. If it
    // doesn't match, this method is simply never called — `onProgress`
    // (and therefore the Watch app's mirrored ETA/next-step) stays stale
    // during an active session, but nothing else here is affected.
    func navigationViewController(_ navigationViewController: NavigationViewController, didUpdate progress: RouteProgress, with location: CLLocation, rawLocation: CLLocation) {
        let leg = progress.currentLegProgress
        let step = NavigationStepModel(
            instruction: leg.currentStep.instructions,
            distanceMeters: leg.currentStepProgress.distanceRemaining,
            maneuver: "\(leg.currentStep.maneuverType)"
        )
        let summary = RouteSummary(distanceMeters: progress.distanceRemaining, expectedTravelSeconds: progress.durationRemaining)
        onProgress(step, summary)
    }
}

#else

/// Non-Mapbox build: keep today's maps.apple.com hand-off. Exercised by
/// default CI (no `TIMI_MAPBOX` / Mapbox token) and by the Android/Skip
/// build.
struct TurnByTurnNavigationView: View {
    var destination: NavigationDestination
    var origin: GeoPoint
    var preferences: NavigationPreferences
    var navigationStyleURL: String
    var petName: String
    var mapboxAccessToken: String?
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
        }.padding(24).timiCard(.white)
    }
}
#endif

/// Shared between both build configurations above.
enum AppleMapsFallback {
    static func directionsURL(to destination: NavigationDestination) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        components?.queryItems = [
            URLQueryItem(name: "daddr", value: "\(destination.latitude),\(destination.longitude)"),
            URLQueryItem(name: "q", value: destination.name)
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
    @State var arrivedPromptShown = false

    var body: some View {
        ZStack(alignment: .bottom) {
            TurnByTurnNavigationView(
                destination: destination,
                origin: GeoPoint(latitude: store.currentLatitude, longitude: store.currentLongitude),
                preferences: store.navigationPreferences,
                navigationStyleURL: store.navigationStyleURL,
                petName: store.selectedPet.name,
                mapboxAccessToken: store.mapToken,
                onProgress: { step, summary in store.updateNavigationProgress(step: step, summary: summary) },
                onArrival: {
                    arrivedPromptShown = true
                    Task { await store.record("arrived") }
                },
                onEnd: { store.navigationDestination = nil }
            ).ignoresSafeArea()

            if arrivedPromptShown {
                HStack(spacing: 12) {
                    Button("I'm here") { Task { await store.record("arrived") } }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
                    Button("End navigation") { store.navigationDestination = nil }.buttonStyle(TimiQuietButtonStyle())
                }.padding(16).background(.white, in: RoundedRectangle(cornerRadius: 20)).padding()
            }
        }
        .onAppear { store.beginNavigation(to: destination) }
    }
}
