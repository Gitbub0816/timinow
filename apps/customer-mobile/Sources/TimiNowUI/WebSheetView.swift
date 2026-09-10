import Foundation
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

// A plain WKWebView, for Didit's hosted identity-verification page.
//
// There is no native Didit SDK — only a JS widget meant for a website, per
// src/hardship/providers.js — so "in-app" here means a web sheet loading the
// session URL the Worker hands back, not an embedded native control.
//
// Guarded exactly like the Mapbox and Stripe imports in ClinicMapView and
// DepositView, and for the same reason: WKWebView is UIKit-backed, so the
// macOS host build that runs `swift test` cannot compile a `UIViewRepresentable`
// wrapping it, and skipstone has no Kotlin/Compose bridge for WKWebView at
// all. This is `#if os(iOS) && !SKIP` rather than `canImport(WebKit)` on
// purpose — WebKit itself exists on macOS too (as `NSViewRepresentable`
// there, a different protocol), and a broader `canImport` guard would compile
// this straight into the macOS test target, which is exactly what happened to
// this app's customer-facing UI before that convention existed.
//
// TODO(android-webview): there is no Android counterpart yet. The fallback
// used by `HardshipIdentitySection` in HardshipViews.swift opens the same
// session URL in the system browser via a plain `Link`, and asks the person
// to come back and tap "check status" once they are done — Didit's hosted
// flow does not reliably redirect anywhere a client can intercept even inside
// a WKWebView, so the in-app version below never tried to detect completion
// either. Closing the gap on Android means adding a Compose `WebView`
// (Google's Accompanist library, or Skip's own bridge if one lands for it)
// behind the same kind of `#if` split DepositView.swift uses for Stripe's
// Android SDK — not attempted here because guessing at a Skip/Compose bridge
// that does not exist yet in this codebase would either silently fail to
// transpile or silently do the wrong thing, and there is no toolchain in this
// environment to find out which.
#if os(iOS) && !SKIP
import WebKit

struct HardshipWebView: UIViewRepresentable {
    var url: URL
    @Binding var isLoading: Bool
    @Binding var loadError: String

    func makeUIView(context: Context) -> WKWebView {
        // Not a bare WKWebView() — that was the whole bug. Didit's hosted
        // verification is a camera-first single-page app: it asks for
        // getUserMedia and an inline camera preview during init, and a
        // default-configured web view on iPhone refuses both
        // (allowsInlineMediaPlayback is off, media playback wants a user
        // gesture, and there is no delegate to grant capture), so the page's
        // startup fails and it renders as an eternal blank white sheet.
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        // uiDelegate is what receives the camera/microphone capture request;
        // without it WebKit denies capture silently.
        view.uiDelegate = context.coordinator
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) { }

    func makeCoordinator() -> Coordinator { Coordinator(isLoading: $isLoading, loadError: $loadError) }

    // A failed navigation says so in words. Before `loadError` existed, a
    // page that could not load (DNS failure, dead link, no network) just
    // cleared the spinner over an empty white WKWebView — a screen with no
    // exit that looks broken because it is.
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        @Binding var isLoading: Bool
        @Binding var loadError: String
        init(isLoading: Binding<Bool>, loadError: Binding<String>) {
            self._isLoading = isLoading
            self._loadError = loadError
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { isLoading = false }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            isLoading = false
            loadError = error.localizedDescription
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            isLoading = false
            loadError = error.localizedDescription
        }

        /// The identity page's camera (and, for liveness prompts, microphone)
        /// request. `.grant` here answers WebKit; iOS still shows its own
        /// system camera prompt the first time, worded by
        /// NSCameraUsageDescription — this is permission to *ask*, not a
        /// bypass. Only granted for the page this sheet was opened on.
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(.grant)
        }
    }
}

/// The sheet chrome around `HardshipWebView`: a loading spinner until the
/// first navigation finishes, and a Done button in Tími's own hand rather
/// than a system close control.
///
/// Didit's hosted flow may not reliably redirect anywhere this WKWebView can
/// intercept, so this never tries to detect a completion URL — the only
/// completion signal is the person pressing Done. `onDismiss` is the cue for
/// the caller to re-poll `identity-status`, exactly the way `DepositView`'s
/// `handleConfirmation` treats an on-device Stripe signal as "go re-check the
/// source of truth", never as truth itself.
struct TimiWebSheet: View {
    var url: URL
    var title: String
    var onDismiss: () -> Void

    // Not `@State private`: Skip cannot bridge private SwiftUI state, and
    // scripts/validate-native.mjs fails the build over it. This file is
    // iOS-only, but the house rule is followed everywhere in this module.
    @State var isLoading = true
    @State var loadError = ""

    var body: some View {
        NavigationStack {
            ZStack {
                HardshipWebView(url: url, isLoading: $isLoading, loadError: $loadError)
                if isLoading {
                    VStack(spacing: 12) {
                        ProgressView().tint(TimiColor.blue)
                        Text("Loading secure verification…").font(.caption).foregroundStyle(TimiColor.muted)
                    }
                    .padding(20)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 16))
                }
                if !loadError.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("This page couldn't load", systemImage: "exclamationmark.triangle.fill")
                            .font(.headline).foregroundStyle(TimiColor.coral)
                        Text(loadError).font(.caption).foregroundStyle(TimiColor.muted)
                        Button("Close") { onDismiss() }.buttonStyle(TimiPrimaryButtonStyle())
                    }
                    .padding(20)
                    .frame(maxWidth: 360)
                    .timiCard(Color.white)
                    .padding(24)
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { onDismiss() }.fontWeight(.bold).foregroundStyle(TimiColor.blue)
                }
            }
        }
    }
}
#endif
