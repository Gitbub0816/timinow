import Foundation
import AppKit
import SwiftUI
import TimiVetCore
import TimiVetUI

// This file is macOS/AppKit-specific by design (unlike TimiVetCore and
// TimiVetUI, which stay Skip-portable behind #if canImport/#if os guards).
// `Sources/TimiVetApp/Skip/skip.yml` has no `mode: native` — it is the same
// thin, per-platform app-composition layer apps/customer-mobile's
// TimiNowApp.swift is, not the reusable part. Package.swift also only
// declares `.macOS(.v14)`, matching that intent.
//
// Owns every long-lived service and every AppKit object (`NSPanel`,
// `NSStatusItem`, extra `NSWindow`s) that must outlive any single SwiftUI
// window — the same role `App.xaml.cs` plays in the Windows client.
@MainActor public final class AppDelegate: NSObject, NSApplicationDelegate {
    public let settingsStore = SettingsStore()
    public let apiClient: ClinicAPIClient
    public let authController: AuthController
    public let clinicStore: ClinicStore
    public let alertCenter: AlertCenter

    private var mainWindow: NSWindow?
    private var mainWindowDelegate: HideInsteadOfCloseDelegate?
    private var floatingPanel: FloatingPanel?
    private var peopleWindow: NSWindow?
    private var peopleWindowDelegate: ClearOnCloseDelegate?
    private var isExiting = false

    public override init() {
        let settings = settingsStore.load()
        let api = ClinicAPIClient(settings: settings)
        apiClient = api
        authController = AuthController(apiClient: api)
        clinicStore = ClinicStore(settingsStore: settingsStore, settings: settings, api: api)
        alertCenter = AlertCenter(settings: settings)
        super.init()
        clinicStore.onNewRequest = { [weak self] request in
            guard let self else { return }
            alertCenter.newRequest(request)
            if clinicStore.settings.autoShowMiniOnNewRequest { showMiniConsole() }
        }
        alertCenter.onOpenMain = { [weak self] in self?.showMainWindow() }
        alertCenter.onOpenMini = { [weak self] in self?.showMiniConsole() }
        alertCenter.onManagePeople = { [weak self] in self?.showPeopleWindow() }
        alertCenter.onExit = { [weak self] in self?.quit() }
        alertCenter.applyLaunchAtLogin()
    }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // The console's palette is a light one — cards on a pale canvas, ink
        // text — and it is drawn by hand. AppKit's own controls are not: a
        // TextField, a TextEditor, a Toggle and a DatePicker follow the system
        // appearance, so on a Mac in dark mode the console rendered dark text
        // boxes inside light cards, with their labels black on black. Nothing
        // in the workspace could be read.
        //
        // The phone app pins itself light the same way (preferredColorScheme
        // plus UIUserInterfaceStyle); this is the macOS half of that, and it
        // was never applied.
        NSApp.appearance = NSAppearance(named: .aqua)
        Task { @MainActor in await authController.start() }
    }

    public func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Called (via `RootView`'s `.task(id:)`) whenever sign-in completes or a
    /// persisted session is restored: apply the session, start polling, and
    /// stand up the floating console.
    public func bootstrapAfterSignIn() async {
        if let session = authController.session { clinicStore.applySession(session) }
        await clinicStore.start()
        ensureFloatingPanel()
    }

    public func signOut() async {
        clinicStore.stop()
        floatingPanel?.orderOut(nil)
        peopleWindow?.close()
        peopleWindow = nil
        await authController.signOut()
    }

    public func quit() {
        isExiting = true
        settingsStore.save(clinicStore.settings)
        NSApp.terminate(nil)
    }

    public func registerMainWindow(_ window: NSWindow) {
        guard mainWindow !== window else { return }
        mainWindow = window
        let delegate = HideInsteadOfCloseDelegate(isExiting: { [weak self] in self?.isExiting ?? false })
        mainWindowDelegate = delegate
        window.delegate = delegate
    }

    public func showMainWindow() {
        NSApp.activate(ignoringOtherApps: true)
        mainWindow?.makeKeyAndOrderFront(nil)
    }

    public func showMiniConsole() {
        ensureFloatingPanel()
        floatingPanel?.orderFrontRegardless()
    }

    private func ensureFloatingPanel() {
        guard floatingPanel == nil else { return }
        floatingPanel = FloatingPanel(store: clinicStore, onOpenMain: { [weak self] in self?.showMainWindow() })
    }

    public func showPeopleWindow() {
        if let peopleWindow {
            peopleWindow.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: PeopleView(api: apiClient, isAdmin: clinicStore.isAdmin).preferredColorScheme(.light))
        let window = NSWindow(contentViewController: hosting)
        window.appearance = NSAppearance(named: .aqua)
        window.title = "Manage People · Tími Vet"
        window.setContentSize(NSSize(width: 560, height: 640))
        window.styleMask = [.titled, .closable, .resizable, .miniaturizable]
        window.isReleasedWhenClosed = false
        let delegate = ClearOnCloseDelegate { [weak self] in self?.peopleWindow = nil }
        peopleWindowDelegate = delegate
        window.delegate = delegate
        peopleWindow = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

/// Intercepts the console window's close button to hide instead of
/// destroying it — the same `e.Cancel = true; Hide();` behavior the Windows
/// `MainWindow`/`MiniWindow` use, so alerts keep running after "closing".
@MainActor final class HideInsteadOfCloseDelegate: NSObject, NSWindowDelegate {
    private let isExiting: () -> Bool
    init(isExiting: @escaping () -> Bool) { self.isExiting = isExiting }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if isExiting() { return true }
        sender.orderOut(nil)
        return false
    }
}

@MainActor final class ClearOnCloseDelegate: NSObject, NSWindowDelegate {
    private let onClose: () -> Void
    init(onClose: @escaping () -> Void) { self.onClose = onClose }
    func windowWillClose(_ notification: Notification) { onClose() }
}

/// Resolves the `NSWindow` hosting a SwiftUI view so `AppDelegate` can attach
/// `HideInsteadOfCloseDelegate` to it — there is no other supported way to
/// reach a `WindowGroup`'s window from outside its view hierarchy.
struct WindowConfigurator: NSViewRepresentable {
    let onResolve: (NSWindow) -> Void
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async {
            if let window = view.window { onResolve(window) }
        }
        return view
    }
    func updateNSView(_ nsView: NSView, context: Context) { }
}
