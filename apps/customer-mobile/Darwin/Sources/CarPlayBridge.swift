import Foundation
import Observation
import TimiNowCore
import TimiNowCarPlay

// Plain Xcode-target file (not part of any SwiftPM target Skip touches):
// the only place that is allowed to import both `TimiNowCore` and
// `TimiNowCarPlay`, since `TimiNowCarPlay` is deliberately never a
// dependency of `TimiNowUI`/`TimiNowApp` (see Package.swift). Bridges
// `AppStore.shared`'s active search/intake into `CarPlayOfferBridge` so the
// CarPlay scene (CarPlaySceneDelegate, instantiated separately by the OS)
// shows the same offers as the phone UI.
@MainActor
final class CarPlayPhoneBridge {
    static let shared = CarPlayPhoneBridge()
    private var store: AppStore?

    func start(observing store: AppStore) {
        self.store = store
        observe()
    }

    private func observe() {
        withObservationTracking {
            _ = store?.currentSearch?.offers
            _ = store?.currentIntake
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.push()
                self?.observe()
            }
        }
    }

    private func push() {
        guard let store else { return }
        if let intake = store.currentIntake, let location = intake.location {
            CarPlayOfferBridge.shared.update(offers: [destination(from: location, store: store)])
            return
        }
        let destinations = (store.currentSearch?.offers ?? []).compactMap { offer -> NavigationDestination? in
            guard let location = offer.location else { return nil }
            return destination(from: location, store: store)
        }
        CarPlayOfferBridge.shared.update(offers: destinations)
    }

    private func destination(from location: ClinicLocation, store: AppStore) -> NavigationDestination {
        NavigationDestination(
            clinicId: location.id,
            name: location.name,
            address: location.address ?? "",
            latitude: location.latitude ?? store.currentLatitude,
            longitude: location.longitude ?? store.currentLongitude,
            phone: location.phone,
            kind: location.kind
        )
    }
}
