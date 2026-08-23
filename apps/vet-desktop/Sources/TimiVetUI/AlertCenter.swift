import Foundation
import TimiVetCore
#if canImport(UserNotifications)
import UserNotifications
#endif
#if canImport(AppKit)
import AppKit
#endif
#if canImport(ServiceManagement)
import ServiceManagement
#endif

/// macOS port of apps/vet-windows/src/TimiVet/Services/AlertService.cs:
/// desktop notifications for new/emergency intake requests via
/// `UNUserNotificationCenter`, plus the menu-bar equivalent of the Windows
/// tray icon (`NSStatusItem` instead of `NotifyIcon`, with the same "Open
/// Tími Vet" / "Open floating console" / "Manage people" / "Exit" items).
/// Also owns launch-at-login through `SMAppService`, the modern replacement
/// for the Windows Run-key autostart.
@MainActor public final class AlertCenter: NSObject {
    #if canImport(AppKit)
    /// Strong reference for the duration of a sound; see `playAlert`.
    private var alertSound: NSSound?
    #endif
    public var onOpenMain: (() -> Void)?
    public var onOpenMini: (() -> Void)?
    public var onManagePeople: (() -> Void)?
    public var onExit: (() -> Void)?

    private var settings: AppSettings

    #if canImport(AppKit)
    private var statusItem: NSStatusItem?
    #endif

    public init(settings: AppSettings) {
        self.settings = settings
        super.init()
        #if canImport(AppKit)
        setUpStatusItem()
        #endif
        #if canImport(UserNotifications)
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        #endif
    }

    public func updateSettings(_ settings: AppSettings) {
        self.settings = settings
        applyLaunchAtLogin()
    }

    /// Body truncated to 177 characters + an ellipsis, matching the Windows
    /// client's balloon tip (`ConcernSummary.Length > 180 ? [..177] + "…"`).
    public func newRequest(_ request: ClinicRequest) {
        guard settings.alertsEnabled else { return }
        #if canImport(AppKit)
        if settings.playSound { playAlert(emergency: request.isEmergency) }
        #endif
        #if canImport(UserNotifications)
        let content = UNMutableNotificationContent()
        content.title = request.isEmergency ? "Emergency intake · \(request.pet.name)" : "New intake · \(request.pet.name)"
        let summary = request.concernSummary
        content.body = summary.count > 177 ? String(summary.prefix(177)) + "…" : summary
        content.sound = settings.playSound ? .default : nil
        let notificationRequest = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(notificationRequest)
        #endif
    }

    #if canImport(AppKit)
    /// A sound that actually plays.
    ///
    /// Two reasons nothing was ever heard. `NSSound.beep()` is the system
    /// alert beep, which follows the Alert Volume slider in Sound settings —
    /// a separate control from output volume, and frequently at zero. And the
    /// notification's own sound is suppressed by macOS while the app is
    /// frontmost, which is exactly when somebody is watching the queue.
    ///
    /// A named system sound goes through normal output and plays whether or
    /// not the console has focus.
    private func playAlert(emergency: Bool) {
        // Sosumi is sharp and short; Submarine is lower and easy to live with
        // when the queue is busy. Ping is the fallback if a system ever ships
        // without them.
        let candidates = emergency ? ["Sosumi", "Ping", "Funk"] : ["Submarine", "Ping", "Funk"]
        var sound: NSSound?
        for name in candidates {
            sound = NSSound(named: NSSound.Name(name))
            if sound != nil { break }
        }
        guard let sound else { return }
        // Held for the length of the sound: an NSSound released while playing
        // stops playing, which is its own silent-alert bug.
        alertSound?.stop()
        alertSound = sound
        sound.stop()
        sound.play()
    }

    /// Plays the alert on demand, so "no sound fires" can be checked without
    /// waiting for a real request to arrive.
    public func previewAlert() { playAlert(emergency: false) }
    #endif

    // MARK: - Menu bar

    #if canImport(AppKit)
    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: "cross.case.fill", accessibilityDescription: "Tími Vet")
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Tími Vet", action: #selector(handleOpenMain), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open floating console", action: #selector(handleOpenMini), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Manage people", action: #selector(handleManagePeople), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Exit", action: #selector(handleExit), keyEquivalent: "").target = self
        item.menu = menu
        statusItem = item
    }

    @objc private func handleOpenMain() { onOpenMain?() }
    @objc private func handleOpenMini() { onOpenMini?() }
    @objc private func handleManagePeople() { onManagePeople?() }
    @objc private func handleExit() { onExit?() }
    #endif

    // MARK: - Launch at login

    public func applyLaunchAtLogin() {
        #if canImport(ServiceManagement)
        do {
            if settings.startAtLogin {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            // Best effort, same as the Windows client's silent registry fallback.
        }
        #endif
    }
}
