// swift-tools-version: 5.9
import Foundation
import PackageDescription

// Mapbox Maps + Navigation are Apple-only SDKs distributed via Swift Package
// Manager. Their binary components require a Mapbox *secret* downloads
// token (scope `DOWNLOADS:READ`) recorded in `~/.netrc` before Xcode or
// `swift build` can actually fetch them — see docs/NAVIGATION.md. That
// token is not available in this repository or in default CI, so the
// dependency is added to the manifest ONLY when `TIMI_MAPBOX=1` is set in
// the environment.
//
// With the flag unset — the default everywhere, including
// `swift package resolve` and `swift test --filter ConcernValidatorTests`
// — the Mapbox packages never enter the dependency graph at all, so
// resolution and the core unit tests work on a machine with no Mapbox
// account. Every Mapbox import in the source is additionally guarded with
// `#if canImport(MapboxMaps) && !SKIP && os(iOS)` (or the navigation/CarPlay
// equivalents), so the app, TimiNowCarPlay, and the Skip/Android build all
// compile against the non-Mapbox fallback path in that configuration.
let enableMapbox = ProcessInfo.processInfo.environment["TIMI_MAPBOX"] == "1"

var packageDependencies: [Package.Dependency] = [
    .package(url: "https://source.skip.tools/skip.git", from: "1.7.0"),
    .package(url: "https://source.skip.tools/skip-ui.git", from: "1.29.3"),
    .package(url: "https://source.skip.tools/skip-model.git", from: "1.5.0"),
    .package(url: "https://source.skip.tools/skip-fuse-ui.git", from: "1.0.0"),
    .package(url: "https://source.skip.tools/skip-fuse.git", from: "1.0.2")
]

var timiNowUIDependencies: [Target.Dependency] = [
    "TimiNowCore", .product(name: "SkipFuseUI", package: "skip-fuse-ui")
]

var timiNowCarPlayDependencies: [Target.Dependency] = ["TimiNowCore"]

if enableMapbox {
    packageDependencies.append(contentsOf: [
        .package(url: "https://github.com/mapbox/mapbox-maps-ios.git", from: "11.26.0"),
        .package(url: "https://github.com/mapbox/mapbox-navigation-ios.git", from: "3.27.0")
    ])
    // MapboxDirections is declared explicitly: MapboxNavigationCore depends on
    // it for Waypoint, RouteOptions, RoadClasses, RouteStep, and
    // SpokenInstruction, but does not re-export it, so files that name those
    // types need the product on the target as well as an import.
    // Conditioned on iOS. These SDKs import UIKit, which does not exist on
    // macOS, and `swift test` builds the whole package for the host — so
    // without the condition, running the core unit tests on a Mac that has a
    // downloads token configured fails with "no such module 'UIKit'" from
    // inside Mapbox's own sources. The condition keeps the dependency out of
    // the macOS build while leaving the iOS app and CarPlay builds unchanged.
    timiNowUIDependencies.append(contentsOf: [
        .product(name: "MapboxMaps", package: "mapbox-maps-ios", condition: .when(platforms: [.iOS])),
        .product(name: "MapboxNavigationCore", package: "mapbox-navigation-ios", condition: .when(platforms: [.iOS])),
        .product(name: "MapboxNavigationUIKit", package: "mapbox-navigation-ios", condition: .when(platforms: [.iOS])),
        .product(name: "MapboxDirections", package: "mapbox-navigation-ios", condition: .when(platforms: [.iOS]))
    ])
    timiNowCarPlayDependencies.append(contentsOf: [
        .product(name: "MapboxNavigationCore", package: "mapbox-navigation-ios", condition: .when(platforms: [.iOS])),
        .product(name: "MapboxNavigationUIKit", package: "mapbox-navigation-ios", condition: .when(platforms: [.iOS])),
        .product(name: "MapboxDirections", package: "mapbox-navigation-ios", condition: .when(platforms: [.iOS]))
    ])
}

let package = Package(
    name: "timinow-customer",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14), .macCatalyst(.v17)],
    products: [
        // Only what the Xcode project actually links is a product. A product
        // sharing a name with a target it does not own the linkage of makes
        // Xcode refuse the build: "TimiNowCore is linked as a static library
        // by TimiNow and TimiNowApp, but cannot be built dynamically because
        // there is a package product with the same name." The targets are
        // still built and tested — they are reached through TimiNowApp.
        .library(name: "TimiNowApp", type: .dynamic, targets: ["TimiNowApp"]),
        // Apple-only, opt-in from the Darwin Xcode project (see
        // Darwin/project.yml). Never a dependency of TimiNowUI/TimiNowApp so
        // Skip's Android build never has to compile it.
        .library(name: "TimiNowCarPlay", type: .dynamic, targets: ["TimiNowCarPlay"])
    ],
    dependencies: packageDependencies,
    targets: [
        .target(
            name: "TimiNowApp",
            dependencies: ["TimiNowUI", "TimiNowCore", .product(name: "SkipUI", package: "skip-ui")],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        ),
        .target(
            name: "TimiNowUI",
            dependencies: timiNowUIDependencies,
            resources: [.process("Resources")],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        ),
        .target(
            name: "TimiNowCore",
            dependencies: [
                .product(name: "SkipFuse", package: "skip-fuse"),
                .product(name: "SkipModel", package: "skip-model")
            ],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        ),
        .target(
            name: "TimiNowCarPlay",
            dependencies: timiNowCarPlayDependencies
            // No skipstone plugin: this target is never transpiled/compiled
            // for Android. It is linked only by the Darwin Xcode project.
        ),
        .testTarget(
            name: "TimiNowCoreTests",
            dependencies: ["TimiNowCore", .product(name: "SkipTest", package: "skip")],
            plugins: [.plugin(name: "skipstone", package: "skip")]
        )
    ]
)
