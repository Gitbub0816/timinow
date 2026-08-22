import SwiftUI
import TimiVetApp

@main struct AppMain: App, TimiVetApplication {
    // The one place a property wrapper can attach — see TimiVetApp.swift's
    // `TimiVetApplication` protocol for why the shared `body` cannot declare
    // this itself. Creating `AppDelegate` here also sets it as `NSApp`'s
    // delegate, so `applicationDidFinishLaunching` fires normally.
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
}
