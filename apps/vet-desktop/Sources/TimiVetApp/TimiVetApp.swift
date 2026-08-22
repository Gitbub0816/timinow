import Foundation
import TimiVetCore
import TimiVetUI
import SwiftUI

// `@main` entry point (assembled from Darwin/Sources/Main.swift, which
// declares `@NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate`
// — the one place a property wrapper can attach, since protocol extensions
// cannot introduce stored properties). `AppDelegate` owns the always-on-top
// floating console and the menu-bar item/notifications because both are
// AppKit objects (`NSPanel`, `NSStatusItem`) that need to outlive any single
// SwiftUI window.
//
// Closing the console window hides it instead of quitting — matching the
// Windows client's `e.Cancel = true; Hide();` — with Quit reachable from the
// menu-bar item AlertCenter builds and from the app menu below.
public struct RootView: View {
    let delegate: AppDelegate
    public init(delegate: AppDelegate) { self.delegate = delegate }

    public var body: some View {
        Group {
            if delegate.authController.isSignedIn {
                if delegate.authController.session?.surfaces?.clinic == true {
                    ConsoleView(
                        store: delegate.clinicStore,
                        onOpenMini: { delegate.showMiniConsole() },
                        onManagePeople: { delegate.showPeopleWindow() },
                        onSignOut: { Task { await delegate.signOut() } }
                    )
                } else {
                    NoClinicAccessView(onSignOut: { Task { await delegate.signOut() } })
                }
            } else {
                AuthView(auth: delegate.authController)
            }
        }
        .frame(minWidth: 1180, minHeight: 720)
        .background(WindowConfigurator { window in delegate.registerMainWindow(window) })
        .task(id: delegate.authController.isSignedIn) {
            if delegate.authController.isSignedIn { await delegate.bootstrapAfterSignIn() }
        }
    }
}

/// `appDelegate` is a protocol *requirement*, not a stored property added by
/// the extension below — Swift does not allow a property wrapper
/// (`@NSApplicationDelegateAdaptor`) inside a protocol extension's default
/// implementation, so the conforming `@main` type (Darwin/Sources/Main.swift)
/// supplies it, and every default here just reads through to that one
/// instance.
public protocol TimiVetApplication: App {
    var appDelegate: AppDelegate { get }
}

public extension TimiVetApplication {
    var body: some Scene {
        WindowGroup {
            RootView(delegate: appDelegate)
        }
        .defaultSize(width: 1440, height: 900)
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Open Floating Console") { appDelegate.showMiniConsole() }
                Button("Manage People…") { appDelegate.showPeopleWindow() }
                Divider()
                Button("Sign Out") { Task { await appDelegate.signOut() } }
            }
        }
    }
}
