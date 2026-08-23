import Foundation
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
///   other spaces and full-screen apps, `.floating` does not.
/// - `collectionBehavior` lets the panel follow the user across Spaces and
///   alongside full-screen apps instead of being left behind.
/// - Position and size are restored from `AppSettings.miniWindow*` and saved
///   back on every move/resize — the WPF version hardcodes `Left="80"
///   Top="80"` on every launch; this fixes that.
@MainActor public final class FloatingPanel: NSPanel, NSWindowDelegate {
    private let store: ClinicStore

    public init(store: ClinicStore, onOpenMain: @escaping () -> Void) {
        self.store = store
        let width = max(350, store.settings.miniWindowWidth ?? 390)
        let height = max(230, store.settings.miniWindowHeight ?? 300)
        let left = store.settings.miniWindowLeft ?? 80
        let top = store.settings.miniWindowTop ?? 80
        let rect = NSRect(x: left, y: top, width: width, height: height)

        super.init(
            contentRect: rect,
            styleMask: [.nonactivatingPanel, .utilityWindow, .titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )

        title = "Tími floating intake"
        isFloatingPanel = true
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        isOpaque = false
        backgroundColor = .clear
        isMovableByWindowBackground = true
        minSize = NSSize(width: 350, height: 230)
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
            onTopmostChanged: { [weak self] in self?.applyLevel() }
        ).preferredColorScheme(.light))
        // Hosted in its own AppKit window, so it does not inherit the main
        // window's scheme and has to say so itself.
        appearance = NSAppearance(named: .aqua)
        contentView = hosting
        applyLevel()
    }

    public override var canBecomeKey: Bool { true }
    public override var canBecomeMain: Bool { false }

    /// Re-reads `settings.miniWindowTopmost`/`stayAboveEverything` and
    /// updates the live window level — called from the mini console's own
    /// "Always on top" toggle, and once at construction.
    public func applyLevel() {
        guard store.settings.miniWindowTopmost else { level = .normal; return }
        level = store.settings.stayAboveEverything ? .screenSaver : .floating
    }

    public func windowDidMove(_ notification: Notification) { persistGeometry() }
    public func windowDidResize(_ notification: Notification) { persistGeometry() }
    public func windowDidEndLiveResize(_ notification: Notification) { persistGeometry() }

    private func persistGeometry() {
        let f = frame
        store.saveMiniWindowGeometry(left: f.origin.x, top: f.origin.y, width: f.width, height: f.height)
    }
}
#endif
