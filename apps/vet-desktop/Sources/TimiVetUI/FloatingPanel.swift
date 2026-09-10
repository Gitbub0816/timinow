import Foundation
import Observation
import TimiVetCore
#if canImport(AppKit)
import AppKit
import SwiftUI

/// The always-on-top floating console: a real `NSPanel` subclass hosting
/// `MiniConsoleView`, replacing the WPF `MiniWindow`'s
/// `AllowsTransparency="True"` borderless `Topmost` window.
///
/// - `.nonactivatingPanel` + `.utilityWindow` keep it from stealing focus or
///   showing up as its own Dock/⌘-Tab entry, the AppKit equivalent of the
///   WPF window's `ShowInTaskbar` tuning.
/// - `level` is `.floating` normally, or `.screenSaver` when the person picks
///   "stay above everything" in Settings — `.screenSaver` also floats above
///   other spaces and full-screen apps, `.floating` does not. Both toggles
///   live in Clinic settings (there is no control on the pill), and the panel
///   observes them via `withObservationTracking`, so flipping either applies
///   to the live window immediately — no restart, no callback plumbing.
/// - `collectionBehavior` lets the panel follow the user across Spaces and
///   alongside full-screen apps instead of being left behind.
/// - The frame follows the content, not the user: `MiniConsoleView` reports
///   its measured size (a tight capsule when idle, a decision card when a
///   request is waiting) and `fit(to:)` animates the panel to match, keeping
///   the top-right corner fixed so growth reads as the pill expanding
///   downward/leftward rather than the window jumping. `.resizable` is gone
///   with it — a content-sized window has nothing for a drag-handle to do.
/// - Position is restored from `AppSettings.miniWindowLeft/Top` and saved
///   back on every move — the WPF version hardcodes `Left="80" Top="80"` on
///   every launch; this fixes that. Width/height are no longer restored:
///   the content decides them now.
@MainActor public final class FloatingPanel: NSPanel, NSWindowDelegate {
    private let store: ClinicStore
    private var lastContentSize = NSSize.zero

    public init(store: ClinicStore, onOpenMain: @escaping () -> Void) {
        self.store = store
        let left = store.settings.miniWindowLeft ?? 80
        let top = store.settings.miniWindowTop ?? 80
        // Placeholder size only: the first content measurement replaces it
        // before the panel is ever shown.
        let rect = NSRect(x: left, y: top, width: 320, height: 120)

        super.init(
            contentRect: rect,
            styleMask: [.nonactivatingPanel, .utilityWindow, .titled, .closable, .fullSizeContentView],
            backing: .buffered, defer: false
        )

        title = "Tími floating intake"
        isFloatingPanel = true
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        isOpaque = false
        backgroundColor = .clear
        isMovableByWindowBackground = true
        hasShadow = false
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        delegate = self

        let hosting = NSHostingView(rootView: MiniConsoleView(
            store: store,
            onOpenMain: onOpenMain,
            onMinimize: { [weak self] in self?.miniaturize(nil) },
            onHide: { [weak self] in self?.orderOut(nil) },
            onContentSizeChange: { [weak self] size in self?.fit(to: size) }
        ).preferredColorScheme(.light))
        // Hosted in its own AppKit window, so it does not inherit the main
        // window's scheme and has to say so itself.
        appearance = NSAppearance(named: .aqua)
        contentView = hosting
        applyLevel()
        observeLevelSettings()
    }

    public override var canBecomeKey: Bool { true }
    public override var canBecomeMain: Bool { false }

    /// Re-reads `settings.miniWindowTopmost`/`stayAboveEverything` and
    /// updates the live window level — called once at construction, then
    /// whenever `observeLevelSettings` sees either setting change.
    public func applyLevel() {
        guard store.settings.miniWindowTopmost else { level = .normal; return }
        level = store.settings.stayAboveEverything ? .screenSaver : .floating
    }

    /// `ClinicStore` is `@Observable` and `settings` is one of its stored
    /// properties, so `withObservationTracking` fires when either checkbox
    /// in ConsoleView's "Floating console" settings card mutates it. The
    /// registration is one-shot by design; re-arm after every change.
    private func observeLevelSettings() {
        withObservationTracking {
            _ = store.settings.miniWindowTopmost
            _ = store.settings.stayAboveEverything
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.applyLevel()
                self.observeLevelSettings()
            }
        }
    }

    /// Animates the panel's frame to the measured SwiftUI content size,
    /// holding the top-right corner fixed (Cocoa origins are bottom-left, so
    /// that means keeping `maxX`/`maxY`): the idle pill grows down and to
    /// the left into the decision card, and collapses back the same way.
    func fit(to size: CGSize) {
        guard size.width > 1, size.height > 1 else { return }
        let target = NSSize(width: ceil(size.width), height: ceil(size.height))
        guard target != lastContentSize else { return }
        lastContentSize = target
        let current = frame
        var next = frameRect(forContentRect: NSRect(origin: .zero, size: target))
        next.origin.x = current.maxX - next.width
        next.origin.y = current.maxY - next.height
        // No animation while hidden or before first show — only a visible
        // grow/shrink should be animated.
        setFrame(next, display: true, animate: isVisible)
    }

    public func windowDidMove(_ notification: Notification) {
        let f = frame
        store.saveMiniWindowGeometry(left: f.origin.x, top: f.origin.y, width: f.width, height: f.height)
    }
}
#endif
