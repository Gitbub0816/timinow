import Foundation
import TimiNowCore

// Apple-only, iOS-only. This target is never a dependency of TimiNowUI or
// TimiNowApp — it is linked only by the Darwin Xcode project (see
// Darwin/project.yml), so Skip's Android build never touches it. The
// `#else` stub keeps the type available on any other build configuration
// that happens to compile this target directly (e.g. `swift test` running
// natively on a macOS host), with zero UIKit/CarPlay dependency.

#if os(iOS) && !SKIP
import CarPlay

/// Registered in Darwin/Info.plist under `UIApplicationSceneManifest` >
/// `UISceneConfigurations` > `CPTemplateApplicationSceneSessionRoleApplication`.
///
/// Apple only ever instantiates this delegate on a device/simulator whose
/// provisioning has been granted the
/// `com.apple.developer.carplay-driving-navigation` entitlement — see
/// Darwin/TimiNow.entitlements and docs/NAVIGATION.md for the approval
/// process. Without that grant the OS never creates a CarPlay scene at
/// all, so this code path is inert (not merely disabled) until Apple
/// signs off — this is an application process with Apple, not a checkbox
/// in Xcode.
@objc(CarPlaySceneDelegate)
public final class CarPlaySceneDelegate: NSObject, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?

    #if canImport(MapboxNavigationUIKit)
    private var carPlayManager: CarPlayManager?
    #endif

    public func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController
        #if canImport(MapboxNavigationUIKit)
        // NOTE ON VERIFICATION: `CarPlayManager`'s exact wiring (which
        // properties it exposes for the interface controller, and the
        // exact call to hand it a route once "Navigate" is tapped) was not
        // independently verified against the installed SDK — confirm on a
        // Mac before shipping. Until then this only shows the offer list;
        // tapping "Navigate" is a no-op in the CarPlay scene.
        let manager = CarPlayManager()
        carPlayManager = manager
        #endif
        interfaceController.setRootTemplate(offersListTemplate(), animated: true, completion: nil)
    }

    public func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        self.interfaceController = nil
        #if canImport(MapboxNavigationUIKit)
        carPlayManager = nil
        #endif
    }

    /// Mirrors the phone's active care search: the chosen clinic once one
    /// is selected, or the ranked offers before then. Populated by
    /// `CarPlayOfferBridge`, which the Darwin host app
    /// (Darwin/Sources/CarPlayBridge.swift) keeps in sync with
    /// `AppStore.shared`.
    private func offersListTemplate() -> CPListTemplate {
        let destinations = CarPlayOfferBridge.shared.currentOffers
        let items: [CPListItem] = destinations.isEmpty
            ? [CPListItem(text: "No active offers", detailText: "Open Tími on your phone to start a search.")]
            : destinations.map { destination in
                let item = CPListItem(text: destination.name, detailText: destination.address)
                item.handler = { [weak self] _, completion in
                    self?.beginNavigation(to: destination)
                    completion()
                }
                return item
            }
        return CPListTemplate(title: "Tími NOW", sections: [CPListSection(items: items)])
    }

    private func beginNavigation(to destination: NavigationDestination) {
        #if canImport(MapboxNavigationUIKit)
        // See the NOTE ON VERIFICATION above — wiring `carPlayManager` to
        // actually start guidance to `destination` still needs to be
        // confirmed against the installed SDK's CarPlayManager API.
        _ = carPlayManager
        #endif
    }
}

/// `TimiNowCarPlay` cannot import `TimiNowUI` (the SwiftUI layer depends on
/// this package, not the reverse), so the phone app publishes the currently
/// active offers here whenever `AppStore` changes. See `WatchBridge.swift`
/// (TimiNowUI) for the equivalent watchOS-facing bridge, and
/// Darwin/Sources/CarPlayBridge.swift for the code that calls `update(offers:)`.
@MainActor
public final class CarPlayOfferBridge {
    public static let shared = CarPlayOfferBridge()
    public private(set) var currentOffers: [NavigationDestination] = []

    public func update(offers: [NavigationDestination]) {
        currentOffers = offers
    }
}

#else

public final class CarPlaySceneDelegate {
    // CarPlay is iOS-only. This stub keeps the type available so the rest
    // of the package graph — a non-iOS host running `swift test`, or a
    // hypothetical Android/Skip build that transitively touched this
    // target — still compiles.
}

@MainActor
public final class CarPlayOfferBridge {
    public static let shared = CarPlayOfferBridge()
    public private(set) var currentOffers: [NavigationDestination] = []
    public func update(offers: [NavigationDestination]) { currentOffers = offers }
}

#endif
