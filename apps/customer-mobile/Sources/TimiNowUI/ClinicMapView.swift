import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

// NOTE ON VERIFICATION: this file was written without access to a Mac,
// Xcode, or a Mapbox account (see docs/NAVIGATION.md), so the exact
// MapboxMaps SwiftUI DSL calls below (`Map`, `Viewport`, `PointAnnotation`,
// `MapStyle`, ...) should be checked against the installed
// mapbox-maps-ios 11.x API before shipping. Every symbol here is behind
// `canImport(MapboxMaps)`, so a mismatch only affects the Mapbox build path
// — the non-Mapbox fallback below compiles independently of Mapbox's API
// surface and is what Skip/Android and default CI actually build.

#if canImport(MapboxMaps) && !SKIP && os(iOS)
import MapboxMaps
import CoreLocation
import UIKit

/// Renders customer position + ranked clinic pins (offer comparison) or a
/// single selected clinic + live route line (tracker), in Tími's custom
/// style from `docs/PLATFORM-CONTRACT.md` ("One style everywhere").
struct ClinicMapView: View {
    var clinics: [ClinicLocation]
    var selectedClinicId: String?
    var userLatitude: Double
    var userLongitude: Double
    var styleURL: String
    var routeCoordinates: [GeoPoint] = []

    @State var viewport: Viewport = .camera(center: CLLocationCoordinate2D(latitude: 37.6688, longitude: -122.0808), zoom: 11)

    var body: some View {
        Map(viewport: $viewport) {
            PointAnnotation(coordinate: CLLocationCoordinate2D(latitude: userLatitude, longitude: userLongitude))
                .iconColor(StyleColor(.systemBlue))

            ForEach(Array(rankedClinics.enumerated()), id: \.element.location.id) { index, ranked in
                if let lat = ranked.location.latitude, let lon = ranked.location.longitude {
                    PointAnnotation(coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon))
                        .textField("\(index + 1)")
                        .textColor(StyleColor(.white))
                        .iconColor(StyleColor(ranked.location.id == selectedClinicId ? .systemBlue : .systemOrange))
                }
            }

            if routeCoordinates.count > 1 {
                PolylineAnnotation(lineCoordinates: routeCoordinates.map { CLLocationCoordinate2D(latitude: $0.latitude, longitude: $0.longitude) })
                    .lineColor(StyleColor(.systemBlue))
                    .lineWidth(5)
            }
        }
        .mapStyle(MapStyle(uri: StyleURI(rawValue: styleURL) ?? .streets))
        .onAppear { recenter() }
        .onChange(of: userLatitude) { _ in recenter() }
    }

    private var rankedClinics: [(location: ClinicLocation, rank: Int)] {
        Array(clinics.prefix(5).enumerated().map { (location: $0.element, rank: $0.offset + 1) })
    }

    private func recenter() {
        viewport = .camera(center: CLLocationCoordinate2D(latitude: userLatitude, longitude: userLongitude), zoom: clinics.isEmpty ? 13 : 11)
    }
}

/// Fetches a route preview (geometry + distance/time summary) for the small
/// map card on the tracker screen, using MapboxNavigationCore's routing
/// provider. Kept separate from full turn-by-turn (NavigationView.swift) —
/// this is only ever a lightweight, cancellable preview.
#if canImport(MapboxNavigationCore)
import MapboxNavigationCore
// Waypoint, RouteOptions, and RoadClasses live in MapboxDirections, which
// MapboxNavigationCore depends on but does not re-export.
import MapboxDirections

/// Fetches the route line and ETA shown on the tracker map, ahead of any
/// decision to start guidance.
///
/// Verified against mapbox-navigation-ios v3.27.3: `MapboxRoutingProvider` has
/// no public initializer, so a provider is obtained from
/// `MapboxNavigationProvider.routingProvider()`. `calculateRoutes(options:)`
/// returns `Task<NavigationRoutes, Error>`, not a completion handler, and
/// `NavigationRoute.route` is non-optional.
enum RoutePreviewFetcher {
    static func fetch(
        from origin: GeoPoint,
        to destination: GeoPoint,
        preferences: NavigationPreferences,
        mapToken: String
    ) async -> (coordinates: [GeoPoint], summary: RouteSummary)? {
        guard !mapToken.isEmpty else { return nil }
        let originWaypoint = Waypoint(
            coordinate: CLLocationCoordinate2D(latitude: origin.latitude, longitude: origin.longitude)
        )
        let destinationWaypoint = Waypoint(
            coordinate: CLLocationCoordinate2D(latitude: destination.latitude, longitude: destination.longitude)
        )
        let options = NavigationRouteOptions(
            waypoints: [originWaypoint, destinationWaypoint],
            profileIdentifier: .automobileAvoidingTraffic
        )
        var avoid: RoadClasses = []
        if preferences.avoidTolls { avoid.insert(.toll) }
        if preferences.avoidHighways { avoid.insert(.motorway) }
        if preferences.avoidFerries { avoid.insert(.ferry) }
        options.roadClassesToAvoid = avoid

        // The preview needs no voice, so this provider is configured with
        // credentials only.
        let provider = MapboxNavigationProvider(
            coreConfig: CoreConfig(credentials: NavigationCoreApiConfiguration(accessToken: mapToken))
        )
        do {
            let navigationRoutes = try await provider.routingProvider().calculateRoutes(options: options).value
            let route = navigationRoutes.mainRoute.route
            let coordinates = (route.shape?.coordinates ?? [])
                .map { GeoPoint(latitude: $0.latitude, longitude: $0.longitude) }
            let summary = RouteSummary(
                distanceMeters: route.distance,
                expectedTravelSeconds: route.expectedTravelTime
            )
            return (coordinates, summary)
        } catch {
            return nil
        }
    }
}
#else
enum RoutePreviewFetcher {
    static func fetch(
        from origin: GeoPoint,
        to destination: GeoPoint,
        preferences: NavigationPreferences,
        mapToken: String
    ) async -> (coordinates: [GeoPoint], summary: RouteSummary)? { nil }
}
#endif

#else

/// Non-Mapbox fallback: a ranked list card instead of a live map. This is
/// the path exercised by default CI (no `TIMI_MAPBOX` flag / Mapbox token)
/// and by the Android/Skip build, so it must compile with zero Mapbox
/// dependency and stay Skip-safe (no private SwiftUI state, no iOS-only
/// navigation-bar view modifiers).
struct ClinicMapView: View {
    var clinics: [ClinicLocation]
    var selectedClinicId: String?
    var userLatitude: Double
    var userLongitude: Double
    var styleURL: String
    var routeCoordinates: [GeoPoint] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: "MAP NOT INCLUDED IN THIS BUILD")
            ForEach(Array(clinics.prefix(5).enumerated()), id: \.element.id) { index, clinic in
                HStack(spacing: 12) {
                    Text("\(index + 1)")
                        .font(.system(size: 14, weight: .black))
                        .frame(width: 26, height: 26)
                        .background(clinic.id == selectedClinicId ? TimiColor.blue : TimiColor.goldSoft, in: Circle())
                        .foregroundStyle(clinic.id == selectedClinicId ? .white : TimiColor.ink)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(clinic.name).font(.callout).fontWeight(.bold)
                        Text(clinic.address ?? "Address shown on confirmation").font(.caption2).foregroundStyle(TimiColor.muted)
                    }
                    Spacer()
                }
            }
        }.padding(14).timiCard(.white)
    }
}

enum RoutePreviewFetcher {
    static func fetch(from origin: GeoPoint, to destination: GeoPoint, preferences: NavigationPreferences) async -> (coordinates: [GeoPoint], summary: RouteSummary)? { nil }
}
#endif
