import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

// Written without a Mac or Xcode, so every Mapbox symbol used below was read
// out of a local clone of mapbox-navigation-ios at v3.27.3 rather than
// remembered. Confirmed there:
//
//   - `TTSConfig`/`CoreConfig` is where a custom voice is installed, not
//     `NavigationOptions` (see VoiceController.swift).
//   - Day and night styles are subclasses overriding `mapStyleURL`.
//   - `RouteOptions.roadClassesToAvoid` takes `.toll` / `.motorway` / `.ferry`.
//   - `MapboxRoutingProvider` has no public initializer; a provider comes from
//     `MapboxNavigationProvider.routingProvider()`.
//   - `calculateRoutes(options:)` returns `Task<NavigationRoutes, Error>`, so
//     it is awaited through `.value` rather than a completion handler.
//   - `NavigationOptions` is assembled from `mapboxNavigation`,
//     `routeVoiceController`, and `eventsManager()` on the provider.
//   - `NavigationRoute.route` is non-optional.
//   - `handleCancelAction()` (NavigationViewController.swift:499) calls
//     `delegate?.navigationViewControllerDidDismiss(_:byCanceling:) != nil`
//     and, because the protocol ships a default implementation, that is
//     non-nil for ANY delegate — so once a delegate is set, the SDK never
//     dismisses itself and the × button does nothing unless the delegate
//     really implements that method. Implemented below; it is the exit.
//   - Every appearance class and property in the Tími chrome
//     (`applyTimiNavigationChrome`) — TopBannerView, InstructionsBannerView,
//     PrimaryLabel.normalTextColor, DistanceLabel.unitTextColor/valueTextColor,
//     ManeuverView.primaryColor, LaneView, WayNameView.borderColor,
//     CancelButton, FloatingButton.borderWidth, ResumeButton.cornerRadius,
//     TimeRemainingLabel.trafficUnknownColor and the rest — was copied out of
//     Styles/DayStyle.swift, which sets the same properties the same way.
//
// None of that is a substitute for compiling it. Everything here is
// `canImport` guarded, so a mismatch affects only the Mapbox build path; the
// `#else` fallback below compiles independently and is what default CI and the
// Android/Skip build actually exercise.

#if canImport(MapboxNavigationUIKit) && canImport(MapboxNavigationCore) && !SKIP && os(iOS)
import MapboxNavigationCore
import MapboxNavigationUIKit
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

/// Pins both Mapbox Navigation's day and night styles to Tími's single
/// custom style (docs/PLATFORM-CONTRACT.md: "One style everywhere"),
/// instead of Mapbox's default streets/dark styles.
// `mapStyleURL` keeps Mapbox's own default when ours will not parse. It was
// force-unwrapped, so a style URL that arrived empty or malformed from
// /api/config took the whole app down at the moment somebody pressed Navigate
// — the one screen where a crash costs the most.
final class TimiDayStyle: StandardDayStyle {
    required init() {
        super.init()
        if let url = URL(string: TimiNowUIStyleSource.current) { mapStyleURL = url }
    }

    override func apply() {
        super.apply()
        applyTimiNavigationChrome(night: false)
    }
}

final class TimiNightStyle: StandardNightStyle {
    required init() {
        super.init()
        if let url = URL(string: TimiNowUIStyleSource.current) { mapStyleURL = url }
    }

    override func apply() {
        super.apply()
        applyTimiNavigationChrome(night: true)
    }
}

/// The customer app's palette, as UIKit colors for Mapbox's appearance
/// proxies. Values match `TimiColor` (Components.swift) — kept as literals
/// here because `TimiColor` is SwiftUI `Color` and converting through
/// `UIColor(Color)` resolves against a trait collection, which is exactly
/// the ambiguity appearance proxies cannot carry.
private enum TimiNavPalette {
    static let ink = UIColor(red: 17 / 255, green: 27 / 255, blue: 59 / 255, alpha: 1)
    static let inkRaised = UIColor(red: 26 / 255, green: 39 / 255, blue: 80 / 255, alpha: 1)
    static let cream = UIColor(red: 255 / 255, green: 250 / 255, blue: 240 / 255, alpha: 1)
    static let creamSoft = UIColor(red: 255 / 255, green: 250 / 255, blue: 240 / 255, alpha: 0.72)
    static let blue = UIColor(red: 35 / 255, green: 87 / 255, blue: 217 / 255, alpha: 1)
    static let gold = UIColor(red: 247 / 255, green: 200 / 255, blue: 75 / 255, alpha: 1)
    static let muted = UIColor(red: 111 / 255, green: 116 / 255, blue: 131 / 255, alpha: 1)
}

/// Reskins Mapbox's drive UI in Tími's own chrome so the one screen a
/// customer stares at longest stops looking like a stock SDK: navy
/// instruction banner with cream text and a gold turn arrow (the same navy
/// header every Tími surface carries), paper-cream trip bar, hard-bordered
/// white floating buttons.
///
/// This is Mapbox's supported customization path — the SDK's own
/// `DayStyle.apply()` sets exactly these appearance properties on exactly
/// these classes, and this runs after `super.apply()` so it wins. Day and
/// night differ only in the trip bar: the banner navy already reads as a
/// night surface.
///
/// Deliberately NOT `@MainActor`: `Style.apply()` is non-isolated in the SDK
/// (only `applyMapStyle(to:)` carries the annotation), so an isolated helper
/// could not be called from the `apply()` overrides above. The SDK's own
/// `DayStyle.apply()` makes these same UIAppearance calls from the same
/// non-isolated context.
private func applyTimiNavigationChrome(night: Bool) {
    let p = TimiNavPalette.self
    for traits in [UITraitCollection(userInterfaceIdiom: .phone), UITraitCollection(userInterfaceIdiom: .pad)] {
        // Top: the turn-by-turn banner. Navy card, cream instruction, gold arrow.
        TopBannerView.appearance(for: traits).backgroundColor = p.ink
        InstructionsBannerView.appearance(for: traits).backgroundColor = p.ink
        PrimaryLabel.appearance(for: traits, whenContainedInInstancesOf: [InstructionsBannerView.self])
            .normalTextColor = p.cream
        SecondaryLabel.appearance(for: traits, whenContainedInInstancesOf: [InstructionsBannerView.self])
            .normalTextColor = p.creamSoft
        DistanceLabel.appearance(for: traits, whenContainedInInstancesOf: [InstructionsBannerView.self])
            .valueTextColor = p.gold
        DistanceLabel.appearance(for: traits, whenContainedInInstancesOf: [InstructionsBannerView.self])
            .unitTextColor = p.creamSoft
        ManeuverView.appearance(for: traits, whenContainedInInstancesOf: [InstructionsBannerView.self])
            .primaryColor = p.gold
        ManeuverView.appearance(for: traits, whenContainedInInstancesOf: [InstructionsBannerView.self])
            .secondaryColor = p.creamSoft

        // The "then…" banner and lane guidance ride under the main banner.
        NextBannerView.appearance(for: traits).backgroundColor = p.inkRaised
        NextInstructionLabel.appearance(for: traits, whenContainedInInstancesOf: [NextBannerView.self])
            .normalTextColor = p.cream
        ManeuverView.appearance(for: traits, whenContainedInInstancesOf: [NextBannerView.self])
            .primaryColor = p.gold
        ManeuverView.appearance(for: traits, whenContainedInInstancesOf: [NextBannerView.self])
            .secondaryColor = p.creamSoft
        LanesView.appearance(for: traits).backgroundColor = p.inkRaised
        LaneView.appearance(for: traits).primaryColor = p.cream
        LaneView.appearance(for: traits).secondaryColor = p.muted

        // Bottom: the trip bar (ETA / distance / ×). Paper by day, navy by night.
        let tripBar = night ? p.ink : p.cream
        let tripText = night ? p.cream : p.ink
        BottomBannerView.appearance(for: traits).backgroundColor = tripBar
        BottomPaddingView.appearance(for: traits).backgroundColor = tripBar
        TimeRemainingLabel.appearance(for: traits).normalTextColor = tripText
        // TimeRemainingLabel colors itself by congestion once underway;
        // "unknown" is the resting state and should match the bar's text.
        TimeRemainingLabel.appearance(for: traits).trafficUnknownColor = tripText
        DistanceRemainingLabel.appearance(for: traits).normalTextColor = night ? p.creamSoft : p.muted
        ArrivalTimeLabel.appearance(for: traits).normalTextColor = night ? p.creamSoft : p.muted
        CancelButton.appearance(for: traits).tintColor = tripText

        // Floating map buttons and the street-name pill, in the app's
        // hard-border card language.
        FloatingButton.appearance(for: traits).backgroundColor = night ? p.inkRaised : .white
        FloatingButton.appearance(for: traits).tintColor = night ? p.cream : p.ink
        FloatingButton.appearance(for: traits).borderColor = night ? p.cream : p.ink
        FloatingButton.appearance(for: traits).borderWidth = 2
        WayNameView.appearance(for: traits).backgroundColor = p.ink.withAlphaComponent(0.85)
        WayNameView.appearance(for: traits).borderColor = p.gold.withAlphaComponent(0.8)
        WayNameView.appearance(for: traits).borderWidth = 1
        WayNameLabel.appearance(for: traits).normalTextColor = p.cream

        // "Resume" after panning the map: the app's blue primary button.
        ResumeButton.appearance(for: traits).backgroundColor = p.blue
        ResumeButton.appearance(for: traits).tintColor = .white
        ResumeButton.appearance(for: traits).borderColor = p.ink
        ResumeButton.appearance(for: traits).borderWidth = 2
        ResumeButton.appearance(for: traits).cornerRadius = 12
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
    /// Which register to speak in, carried down from the intake's urgency.
    var tone: NavigationTone
    /// Not optional. AppStore holds it as `String?` because it is absent until
    /// /api/config answers, and that optional stops here — one `?? ""` at the
    /// call site, matching ClinicMapView. Threading it further meant handing an
    /// optional to Mapbox initializers that take a String, which is a build
    /// error on the Mapbox path only, so nothing but a device build finds it.
    var mapboxAccessToken: String
    var onProgress: (NavigationStepModel, RouteSummary) -> Void
    var onArrival: () -> Void
    var onEnd: () -> Void

    func makeUIViewController(context: Context) -> UIViewController {
        // The first mark. A crash before viewDidLoad - SwiftUI presentation,
        // host construction - was a crash before any breadcrumb existed, and
        // the next launch reported "none recorded", which reads as innocence
        // and is actually a blind spot.
        TimiBreadcrumb.mark("nav:host_setup")
        TimiNowUIStyleSource.current = navigationStyleURL
        return NavigationHostController(
            destination: destination, origin: origin, preferences: preferences, petName: petName, tone: tone,
            mapboxAccessToken: mapboxAccessToken,
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
    private let tone: NavigationTone
    private let mapboxAccessToken: String
    private let onProgress: (NavigationStepModel, RouteSummary) -> Void
    private let onArrival: () -> Void
    private let onEnd: () -> Void
    private var navigationViewController: NavigationViewController?

    init(destination: NavigationDestination, origin: GeoPoint, preferences: NavigationPreferences, petName: String, tone: NavigationTone, mapboxAccessToken: String, onProgress: @escaping (NavigationStepModel, RouteSummary) -> Void, onArrival: @escaping () -> Void, onEnd: @escaping () -> Void) {
        self.destination = destination
        self.origin = origin
        self.preferences = preferences
        self.petName = petName
        self.tone = tone
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
        // Mapbox is not given an empty access token. NavigationCoreApiConfiguration
        // treats one as a programming error and traps, so this crashed the app
        // rather than failing the route — and the token comes from /api/config,
        // which means any launch that could not reach the Worker armed it.
        // ClinicMapView has guarded exactly this since it was written; the
        // navigation path never did.
        guard !mapboxAccessToken.isEmpty else {
            presentFallback()
            return
        }
        // Each stage is marked before it is entered and cleared after. If the
        // app dies inside one, the next launch reports which — a crash inside
        // a framework cannot be caught in process, so the only report that
        // survives is one written before it happens.
        TimiBreadcrumb.mark("nav:route_request")
        Task { await requestRouteAndPresent() }
    }

    private func requestRouteAndPresent() async {
        // The route starts where the phone actually is, not where AppStore
        // last heard it was. `currentLatitude`/`currentLongitude` begin life
        // as a compiled-in default and only move when something else asks for
        // location, so a customer who granted permission but never triggered
        // that ask was shown a route drawn from the default coordinate — "the
        // route doesn't start at my location". One fresh fix at Navigate time
        // fixes the drawn polyline; during guidance the SDK follows the real
        // GPS regardless. Falls back to the passed origin when permission is
        // missing or the fix times out — same behavior as before, never worse.
        let fresh = await PlatformPermissions.currentLocation()
        let originCoordinate = fresh.map { CLLocationCoordinate2D(latitude: $0.0, longitude: $0.1) }
            ?? CLLocationCoordinate2D(latitude: origin.latitude, longitude: origin.longitude)
        let originWaypoint = Waypoint(coordinate: originCoordinate)
        let destinationWaypoint = Waypoint(
            coordinate: CLLocationCoordinate2D(latitude: destination.latitude, longitude: destination.longitude),
            name: destination.name
        )

        // `automobileAvoidingTraffic` is the profile default; naming it keeps the
        // intent explicit, because an emergency drive is exactly the case where
        // live traffic should shape the ETA.
        let options = NavigationRouteOptions(
            waypoints: [originWaypoint, destinationWaypoint],
            profileIdentifier: .automobileAvoidingTraffic
        )
        var avoid: RoadClasses = []
        if preferences.avoidTolls { avoid.insert(.toll) }
        if preferences.avoidHighways { avoid.insert(.motorway) }
        if preferences.avoidFerries { avoid.insert(.ferry) }
        options.roadClassesToAvoid = avoid

        // One provider serves both the route request and the navigation UI, so
        // the credentials and the custom voice configured on it apply to the
        // live session too. `MapboxRoutingProvider` is not publicly
        // constructible; `routingProvider()` is how a caller obtains one.
        TimiBreadcrumb.mark("nav:provider")
        let navigationProvider = makeNavigationProvider()
        do {
            TimiBreadcrumb.mark("nav:calculate_routes")
            let routes = try await navigationProvider.routingProvider().calculateRoutes(options: options).value
            TimiBreadcrumb.mark("nav:present")
            presentNavigation(routes: routes, using: navigationProvider)
        } catch {
            // A route that could not be calculated is a failure, not a crash:
            // the breadcrumb is cleared so the next launch does not report a
            // handled error as one.
            TimiBreadcrumb.clear()
            presentFallback()
        }
    }

    /// The app's one provider, pointed at this drive.
    ///
    /// This built a new `MapboxNavigationProvider` on every press of Navigate,
    /// because the provider carried the voice and the voice knew the pet's
    /// name. The SDK supports one — see TimiNavigationStack — and the second
    /// construction is not something this code can catch failing.
    private func makeNavigationProvider() -> MapboxNavigationProvider {
        TimiNavigationStack.beginTrip(
            clinicName: destination.name,
            petName: petName,
            clinicKind: destination.kind,
            tone: tone
        )
        return TimiNavigationStack.shared(mapToken: mapboxAccessToken, preferences: preferences)
    }

    /// Voice is installed through `CoreConfig.ttsConfig`, not through
    /// `NavigationOptions`. Verified against mapbox-navigation-ios v3.27.3:
    /// `NavigationCoreApiConfiguration(accessToken:)` fills the navigation, map,
    /// and speech configurations from one token, and `NavigationOptions` is
    /// assembled from three members of the provider — `mapboxNavigation`,
    /// `routeVoiceController`, and `eventsManager()`.
    private func presentNavigation(routes: NavigationRoutes, using navigationProvider: MapboxNavigationProvider) {
        TimiBreadcrumb.mark("nav:styles")
        let dayStyle = TimiDayStyle()
        let nightStyle = TimiNightStyle()
        let navigationOptions = NavigationOptions(
            mapboxNavigation: navigationProvider.mapboxNavigation,
            voiceController: navigationProvider.routeVoiceController,
            eventsManager: navigationProvider.eventsManager(),
            styles: [dayStyle, nightStyle]
        )
        TimiBreadcrumb.mark("nav:vc_init")
        let vc = NavigationViewController(navigationRoutes: routes, navigationOptions: navigationOptions)
        vc.delegate = self
        vc.modalPresentationStyle = .fullScreen
        addChild(vc)
        vc.view.frame = view.bounds
        vc.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(vc.view)
        vc.didMove(toParent: self)
        navigationViewController = vc
        // NOT cleared here, and that is the lesson of "none recorded".
        //
        // The first version cleared the breadcrumb at this line - "anything
        // after this is somebody driving" - and the crash turned out to live
        // exactly there: the presented controller's first frames, where the
        // style loads, Metal starts, the location engine spins up and the
        // trip session begins. Clearing on present put the crash in the one
        // window with no name on it, so the next launch reported nothing.
        // The mark stays until navigation ends - finish, arrival, fallback -
        // and a drive the app did not survive therefore names itself. A
        // force-quit mid-drive leaves the mark too, which the report's
        // wording already hedges: "killed or trapped".
        TimiBreadcrumb.mark("nav:live")
    }

    private func presentFallback() {
        TimiBreadcrumb.clear()
        // Route request failed (offline, misconfigured token, etc.) — used to
        // open maps.apple.com and call onEnd() in the same beat, which
        // switched away to the Maps app and dismissed this screen at once:
        // from the tap that started it, that read as Navigate doing nothing
        // (a flash of white, then straight back to the tracker) or as the
        // app unexpectedly leaving itself. Presenting Tími's own card instead
        // means the customer sees why, and chooses to open Maps themselves.
        let fallback = UIHostingController(rootView: NavigationFallbackCard(
            destination: destination,
            onOpenMaps: { [weak self] in
                guard let self, let url = AppleMapsFallback.directionsURL(to: self.destination) else { return }
                UIApplication.shared.open(url)
            },
            onArrival: onArrival,
            onEnd: onEnd
        ))
        addChild(fallback)
        fallback.view.frame = view.bounds
        fallback.view.backgroundColor = .clear
        fallback.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(fallback.view)
        fallback.didMove(toParent: self)
    }
}

/// What `NavigationHostController.presentFallback()` shows in place of the
/// in-app map when Mapbox has no token or a route could not be calculated.
/// Deliberately a separate type from the non-Mapbox build's own
/// `TurnByTurnNavigationView` (below, in the `#else` branch of this file) —
/// the two are mutually exclusive compile targets, so there is no single
/// shared type to reuse between them.
private struct NavigationFallbackCard: View {
    let destination: NavigationDestination
    let onOpenMaps: () -> Void
    let onArrival: () -> Void
    let onEnd: () -> Void

    var body: some View {
        VStack {
            Spacer()
            VStack(spacing: 18) {
                Eyebrow(text: "COULDN'T START IN-APP NAVIGATION")
                Text("Open Maps instead to get directions.").font(.title3).fontWeight(.bold).multilineTextAlignment(.center)
                Text("\(destination.name)\n\(destination.address)").font(.callout).foregroundStyle(TimiColor.muted).multilineTextAlignment(.center)
                Button { onOpenMaps() } label: { Label("Open in Maps", systemImage: "map.fill") }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
                Button("I'm here") { onArrival() }.buttonStyle(TimiPrimaryButtonStyle())
                Button("End navigation") { onEnd() }.buttonStyle(TimiQuietButtonStyle())
            }.padding(24).timiCard(Color.white).padding(20)
            Spacer()
        }.background(TimiColor.canvas.ignoresSafeArea())
    }
}

// Both signatures checked against mapbox-navigation-ios v3.27.0's
// NavigationViewControllerDelegate, not assumed. Getting one wrong costs
// nothing at build time and everything at run time: the protocol ships default
// implementations, so a near-miss compiles, silently satisfies no requirement,
// and the method is simply never called.
//
// didArriveAt returned Bool here and does not in the SDK, which is exactly that
// failure — arrival never fired, so "I'm here" was the only way to finish a
// trip and the `arrived` milestone was never recorded on its own.
extension NavigationHostController: NavigationViewControllerDelegate {
    /// The × on the trip bar. `handleCancelAction()` in the SDK checks
    /// `delegate?.navigationViewControllerDidDismiss(...) != nil` — and since
    /// the protocol ships a default implementation, ANY set delegate makes
    /// that non-nil, which the SDK reads as "the receiver handles dismissal"
    /// and does nothing itself. With a delegate set and this method missing,
    /// the × was therefore completely dead: no way out of navigation short
    /// of arriving. This is the real dismissal — tear down the trip and hand
    /// control back to whatever presented the screen.
    func navigationViewControllerDidDismiss(_ navigationViewController: NavigationViewController, byCanceling canceled: Bool) {
        TimiBreadcrumb.clear()
        onEnd()
    }

    func navigationViewController(_ navigationViewController: NavigationViewController, didArriveAt waypoint: Waypoint) {
        TimiBreadcrumb.clear()
        onArrival()
    }

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
                onProgress: { step, summary in store.updateNavigationProgress(step: step, summary: summary) },
                onArrival: {
                    arrivedPromptShown = true
                    if recordsArrival { Task { await store.record("arrived") } }
                },
                onEnd: { finish() }
            ).ignoresSafeArea()

            if arrivedPromptShown {
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
