import SwiftUI
import LayoutLabKit

/// Layout Lab.
///
/// A sketchpad for Tími screen layouts. It talks to nothing, stores nothing
/// but a JSON file in its own Documents folder, and ships separately from the
/// customer app on purpose — see apps/layout-lab/README.md.
@main
struct LayoutLabApp: App {
    var body: some Scene {
        WindowGroup {
            LabRootView()
                // The whole app is one working surface; a light appearance
                // keeps the canvas showing what the product actually looks
                // like rather than a dark-mode approximation of it.
                .preferredColorScheme(.light)
        }
    }
}
