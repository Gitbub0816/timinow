import Foundation
import SwiftUI
import TimiNowCore

// Stripe Elements, mounted inside Tími's own screen.
//
// Guarded exactly like the Mapbox imports in ClinicMapView, and for the same
// reasons: StripePaymentSheet is Apple-only (it imports UIKit, so the macOS
// host build that runs `swift test` cannot compile it), skipstone cannot
// transpile it to Kotlin, and the dependency only enters the package manifest
// when TIMI_STRIPE=1 is set. With the flag unset — the default everywhere
// including CI — this file compiles to the fallback path below.
#if canImport(StripePaymentSheet) && !SKIP && os(iOS)
import StripePaymentSheet
import UIKit
#endif

/// Closes the loop `configuration.returnURL = "timinow://stripe-redirect"`
/// opens: the app declares that scheme to Stripe as where it can send
/// somebody back after an out-of-app step, but nothing ever told iOS the app
/// OWNS that scheme (`CFBundleURLTypes` in Info.plist), and nothing handed a
/// reopening URL back to Stripe's SDK — `StripeAPI.handleURLCallback(with:)`
/// was never called from anywhere. Both halves were missing, so a
/// PaymentIntent confirmation that ever needed the return trip (a
/// card-network fallback to a redirect-based 3DS challenge; today's
/// `allow_redirects: "never"` on the PaymentIntent — see src/stripe.js
/// createPaymentIntent — keeps the ordinary case from ever needing it, but
/// does not change what the app declares itself capable of) had nowhere to
/// land.
///
/// A standalone public type rather than a member of `DepositSection`
/// (internal to this module) because `TimiNowApp` — a separate module,
/// SwiftUI's `.onOpenURL` is only reachable from the app's own root view —
/// is the caller.
public enum TimiStripeReturn {
    /// Returns whether Stripe recognized and handled this URL. Call from
    /// `.onOpenURL` on the app's root view; a `false` result means the URL
    /// was not one of Stripe's and the app's own deep-link handling (if any)
    /// should look at it instead.
    @discardableResult
    public static func handle(_ url: URL) -> Bool {
        #if canImport(StripePaymentSheet) && !SKIP && os(iOS)
        return StripeAPI.handleURLCallback(with: url)
        #else
        return false
        #endif
    }
}

/// The arrival-deposit section of the tracker.
///
/// Never Checkout and never a hosted page. The customer is standing somewhere
/// with a sick animal and has just chosen a clinic; sending them out to a
/// Stripe-branded page at that moment loses both the context and, often, the
/// customer. The payment collection happens on this screen, under Tími's own
/// heading, with Tími's own confirm button.
///
/// What that means concretely is `PaymentSheet.FlowController`: Stripe owns
/// the payment-method fields (which is the point — card numbers must never
/// touch our code, and PCI scope is what that buys), and Tími owns the screen,
/// the copy, the amount, and the button that says "Pay deposit".
struct DepositSection: View {
    @Bindable var store: AppStore

    // Not `@State private`: Skip cannot bridge private SwiftUI state, and
    // scripts/validate-native.mjs fails the build over it.
    @State var errorText: String = ""

    #if canImport(StripePaymentSheet) && !SKIP && os(iOS)
    @State var flowController: PaymentSheet.FlowController?
    @State var paymentOptionLabel: String = ""
    #endif

    var intake: CareIntake? { store.currentIntake }
    var isPaid: Bool { intake?.paymentStatus == "paid" }
    var depositCents: Int { intake?.depositAmountCents ?? 0 }

    var body: some View {
        Group {
            // `TrackerView` shows this section whenever the client's cached
            // `depositAmountCents` is positive, which is only ever a guess —
            // the Worker's own policy is what actually decides whether a
            // deposit is owed (`ensureDepositPaymentIntent` in
            // src/payments.js answers `mode: "none"` when
            // `!intake.policy.depositRequired`, amount notwithstanding). This
            // used to render the full "$50 ARRIVAL DEPOSIT" card regardless,
            // with "No payment is needed right now" contradicting it one line
            // down — a card that both asked for money and said it wasn't
            // needed. Once the Worker answers "none", this whole card
            // switches to saying that plainly instead.
            if store.depositIntent?.mode == "none" {
                noDepositNeeded
            } else {
                depositCard
            }
        }
        .timiCard(TimiColor.goldSoft)
        .task {
            // Asked for once, when the section first appears. The Worker
            // creates the PaymentIntent under an idempotency key derived from
            // the intake and the amount, so this is safe to reach twice — but
            // there is no reason to.
            if !isPaid && depositCents > 0 && store.depositIntent == nil {
                await store.prepareDeposit()
                // `prepareDeposit` swallows its own failure into a silent
                // report — the customer is standing there with a sick animal,
                // not somewhere to hand a stack trace — so a still-nil intent
                // here is the only place left to say anything at all. Without
                // this, a Worker with no STRIPE_SECRET_KEY configured (a 503
                // PAYMENTS_NOT_CONFIGURED before an intent ever exists) left
                // this screen reading "Preparing a secure payment…" forever.
                if store.depositIntent == nil {
                    errorText = "Tími could not reach the payment service. Pay the deposit at the desk, or try again in a moment."
                } else {
                    await prepareElements()
                }
            }
        }
    }

    /// The Worker's policy says this visit needs no deposit at all — not a
    /// transient state, and not the same thing as "not paid yet". No dollar
    /// figure belongs on screen here; showing `depositCents` (a client-side
    /// guess `TrackerView` used just to decide whether to show this section
    /// at all) would be the exact contradiction this replaces.
    var noDepositNeeded: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill").font(.title2).foregroundStyle(TimiColor.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text("No deposit required").font(.headline)
                Text("This visit does not require an arrival deposit.").font(.caption).foregroundStyle(TimiColor.muted)
            }
        }
    }

    var depositCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            Eyebrow(text: isPaid ? "DEPOSIT PAID" : "ARRIVAL DEPOSIT")
            HStack {
                Text(TimiFormat.money(depositCents)).font(.system(size: 34, weight: .bold, design: .serif))
                Spacer()
                Image(systemName: isPaid ? "checkmark.shield.fill" : "creditcard.fill")
                    .font(.title).foregroundStyle(TimiColor.blue)
            }
            Text("The deposit is credited to the clinic's invoice. Remaining veterinary charges are billed by the clinic; Tími does not submit insurance claims.")
                .font(.caption).foregroundStyle(TimiColor.muted)
            // The fee disclosure the terms promise happens at checkout. The
            // amount comes from /api/config (store.customerFeeCents, 1500
            // compiled in), so a clinic passing the whole service fee through
            // is disclosed correctly without an app release.
            Text("Includes a \(TimiFormat.money(store.customerFeeCents)) Tími service fee, charged at the time of service.")
                .font(.caption).fontWeight(.semibold).foregroundStyle(TimiColor.ink)

            if !isPaid { collectionControls }

            if !errorText.isEmpty {
                Text(errorText).font(.caption).foregroundStyle(TimiColor.coral)
            }
        }
    }

    @ViewBuilder
    var collectionControls: some View {
        if store.depositBusy {
            Text("Preparing a secure payment…").font(.caption).foregroundStyle(TimiColor.muted)
        } else if store.depositIntent == nil {
            // prepareDeposit failed outright (network, or the Worker's own
            // 503 when it has no STRIPE_SECRET_KEY configured) — errorText,
            // set in .task, already says why. Nothing to render here: this
            // used to fall through to elementsControls, which shows its own
            // "Preparing a secure payment…" with no flowController ever
            // coming, and no intent means there is nothing left to prepare.
            EmptyView()
        } else if store.depositIntent?.mode == "demo" {
            // A build with no Stripe credentials. Saying so is the honest
            // thing: a card field here would be asking somebody for a card
            // number that goes nowhere.
            Text("This is a demonstration build. No card is collected and no money moves.")
                .font(.caption).foregroundStyle(TimiColor.muted)
        } else if store.depositIntent?.mode == "stripe" {
            elementsControls
        } else {
            // "none" is handled a level up (`body`'s `noDepositNeeded`), so
            // the only mode left reachable through `isPaid == false` here is
            // "paid" — the Worker settled it (a webhook, or paid at the
            // desk) faster than this device's cached `intake.paymentStatus`
            // caught up. Nothing to collect either way.
            Text("This deposit has already been paid.").font(.caption).foregroundStyle(TimiColor.muted)
        }
    }

    #if canImport(StripePaymentSheet) && !SKIP && os(iOS)

    @ViewBuilder
    var elementsControls: some View {
        if let controller = flowController {
            VStack(alignment: .leading, spacing: 10) {
                // Stripe's payment-method picker, opened from our own row.
                // The fields inside it are Stripe's; the row, the wording and
                // the confirm button below are ours.
                PaymentSheet.FlowController.PaymentOptionsButton(
                    paymentSheetFlowController: controller,
                    onSheetDismissed: { paymentOptionLabel = controller.paymentOption?.label ?? "" }
                ) {
                    HStack {
                        Text(paymentOptionLabel.isEmpty ? "Choose how to pay" : paymentOptionLabel)
                            .fontWeight(.bold)
                        Spacer()
                        Image(systemName: "chevron.right")
                    }
                    .foregroundStyle(TimiColor.ink)
                    .padding(14)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 14))
                }

                PaymentSheet.FlowController.ConfirmButton(
                    paymentSheetFlowController: controller,
                    onCompletion: { result in handleConfirmation(result) }
                ) {
                    Text("Pay \(TimiFormat.money(depositCents)) deposit")
                        .fontWeight(.black)
                        .frame(maxWidth: .infinity)
                        .padding(14)
                        .background(TimiColor.blue, in: RoundedRectangle(cornerRadius: 14))
                        .foregroundStyle(.white)
                }
                .disabled(controller.paymentOption == nil)
            }
        } else {
            Text("Preparing a secure payment…").font(.caption).foregroundStyle(TimiColor.muted)
        }
    }

    /// Everything Stripe actually knows about a confirmation failure —
    /// pulled out of the `NSError` userInfo Stripe populates on `PaymentSheetResult.failed`,
    /// not from `error.localizedDescription`.
    ///
    /// `STPPaymentHandler._error(for:...)` (verified against a local clone of
    /// stripe-ios, at the newest tag actually resolvable under this app's
    /// `from: "24.0.0"` pin — see the note on `httpStatusCodeKey` below,
    /// which cost a build once already from checking against the unreleased
    /// default branch instead) maps most of its own failure codes — an
    /// unexpected intent status, a missing return URL, a 3DS2 SDK error, a
    /// confirm-time API error with no card-specific code — to the exact same
    /// fallback string, `NSError.stp_unexpectedErrorMessage()`: "There was
    /// an unexpected error — try again in a few seconds." That is what
    /// `localizedDescription` returns for all of them, which is why every
    /// one of those failures used to look identical on screen and in the
    /// logs. The real cause is still in the error, under `STPError`'s own
    /// keys — `errorMessageKey` carries Stripe's developer-facing detail
    /// (e.g. "No such payment_intent", a client_secret format mismatch, an
    /// unexpected intent status), and `stripeErrorTypeKey`/`stripeErrorCodeKey`
    /// carry the API error's own classification. None of this is PII — it
    /// is Stripe's error taxonomy, not card data — so it is safe to both log
    /// and, in developer mode, show.
    ///
    /// `STPError.httpStatusCodeKey` is deliberately NOT read here: it does
    /// not exist anywhere in the 24.x line stripe-ios-spm resolves to under
    /// this package's `from: "24.0.0"` constraint (checked at both `24.0.0`
    /// and the newest `24.25.0` tag) — it was added in a later major
    /// version this app cannot reach without widening that pin.
    ///
    /// Shared between `DepositSection` and `BookingPaymentSection` rather
    /// than duplicated, the same way `appearance` below is.
    static func stripeFailureDiagnostics(_ error: Error) -> (type: String?, code: String?, detail: String?) {
        let userInfo = (error as NSError).userInfo
        func nonEmpty(_ value: Any?) -> String? {
            guard let text = value as? String, !text.isEmpty else { return nil }
            return text
        }
        return (
            nonEmpty(userInfo[STPError.stripeErrorTypeKey]),
            nonEmpty(userInfo[STPError.stripeErrorCodeKey]),
            nonEmpty(userInfo[STPError.errorMessageKey])
        )
    }

    /// The one sentence every Stripe mount failure shows, with the reason
    /// attached.
    ///
    /// The reason used to be visible only in developer mode, which is seven
    /// taps on the version number in Settings. That is the reason this class
    /// of failure has been diagnosed by hand, over days, rather than read off
    /// the screen: on every real phone the app answered "try again in a
    /// moment" no matter whether the account was inactive, the keys were from
    /// two different accounts, or the intent had already been paid.
    ///
    /// A Stripe error *code* is not a secret — it is a short, stable token
    /// like `resource_missing`, designed to be quoted at support, and every
    /// serious payment UI prints one. The developer-mode text keeps Stripe's
    /// full developer message, which can name object ids and is therefore
    /// still held back from an ordinary customer.
    static func paymentFailureText(_ diagnostics: (type: String?, code: String?, detail: String?), error: Error, developer: Bool) -> String {
        if developer {
            return "Tími could not open a secure payment. [\(diagnostics.type ?? "?")/\(diagnostics.code ?? "?")] \(diagnostics.detail ?? error.localizedDescription)"
        }
        guard let reference = diagnostics.code ?? diagnostics.type else {
            return "Tími could not open a secure payment. Try again in a moment."
        }
        return "Tími could not open a secure payment. Try again in a moment. (Reference: \(reference))"
    }

    /// The same, for a failure during confirmation rather than mounting,
    /// where Stripe's own localized message is already the better sentence.
    static func paymentConfirmText(_ diagnostics: (type: String?, code: String?, detail: String?), error: Error, developer: Bool) -> String {
        if developer {
            return "\(error.localizedDescription)\n[\(diagnostics.type ?? "?")/\(diagnostics.code ?? "?")] \(diagnostics.detail ?? "no further detail from Stripe")"
        }
        guard let reference = diagnostics.code ?? diagnostics.type else { return error.localizedDescription }
        return "\(error.localizedDescription) (Reference: \(reference))"
    }

    /// The row and confirm button above are entirely Tími's own SwiftUI —
    /// this only reaches the one surface that is still Stripe's: the card
    /// form the payment-options sheet opens. Values are `TimiColor` and the
    /// `timiCard`/button corner radii translated to `UIColor`/`CGFloat`,
    /// since `PaymentSheet.Appearance` is a UIKit type and cannot reference
    /// a SwiftUI `Color` directly.
    static var appearance: PaymentSheet.Appearance {
        var appearance = PaymentSheet.Appearance()
        appearance.cornerRadius = 14
        appearance.borderWidth = 2
        appearance.colors.primary = UIColor(red: 0.137, green: 0.341, blue: 0.851, alpha: 1) // TimiColor.blue
        appearance.colors.background = .white
        appearance.colors.componentBackground = .white
        appearance.colors.componentBorder = UIColor(red: 0.067, green: 0.106, blue: 0.231, alpha: 1) // TimiColor.ink
        appearance.colors.componentDivider = UIColor(red: 0.067, green: 0.106, blue: 0.231, alpha: 0.15)
        appearance.colors.text = UIColor(red: 0.067, green: 0.106, blue: 0.231, alpha: 1) // TimiColor.ink
        appearance.colors.textSecondary = UIColor(red: 0.435, green: 0.455, blue: 0.514, alpha: 1) // TimiColor.muted
        appearance.colors.componentText = UIColor(red: 0.067, green: 0.106, blue: 0.231, alpha: 1)
        appearance.colors.componentPlaceholderText = UIColor(red: 0.435, green: 0.455, blue: 0.514, alpha: 1)
        appearance.colors.icon = UIColor(red: 0.137, green: 0.341, blue: 0.851, alpha: 1)
        appearance.colors.danger = UIColor(red: 0.949, green: 0.373, blue: 0.298, alpha: 1) // TimiColor.coral
        appearance.font.base = .systemFont(ofSize: 15, weight: .medium)
        appearance.primaryButton.cornerRadius = 14
        appearance.primaryButton.font = .systemFont(ofSize: 16, weight: .black)
        return appearance
    }

    func prepareElements() async {
        guard let intent = store.depositIntent, intent.mode == "stripe" else { return }
        guard let secret = intent.clientSecret, let publishable = intent.publishableKey else {
            // mode == "stripe" is the Worker promising a real PaymentIntent
            // exists; missing either field here is the Worker's contract
            // broken, not a state elementsControls should sit on forever.
            errorText = "Tími could not open a secure payment. Pay the deposit at the desk, or try again in a moment."
            return
        }
        // Set from the Worker's response rather than compiled in, so rotating
        // the key does not need an App Store release.
        STPAPIClient.shared.publishableKey = publishable

        var configuration = PaymentSheet.Configuration()
        configuration.merchantDisplayName = "Tími NOW"
        // Tími is the merchant of record — the platform takes the charge and
        // pays the clinic separately afterwards — so this is deliberately not
        // the clinic's name. Putting the clinic's name on the statement would
        // misdescribe who the customer is paying.
        configuration.allowsDelayedPaymentMethods = false
        configuration.returnURL = "timinow://stripe-redirect"
        configuration.appearance = Self.appearance

        let creation: Result<PaymentSheet.FlowController, Error> = await withCheckedContinuation { continuation in
            PaymentSheet.FlowController.create(paymentIntentClientSecret: secret, configuration: configuration) { result in
                continuation.resume(returning: result)
            }
        }
        switch creation {
        case .success(let created):
            flowController = created
            paymentOptionLabel = created.paymentOption?.label ?? ""
        case .failure(let error):
            // `.create`'s own failure case carries an Error too, previously
            // discarded here — the exact same generic-message problem as
            // confirmation, at the earlier point where a key/account
            // mismatch or a stale client secret is just as likely to surface.
            let diagnostics = Self.stripeFailureDiagnostics(error)
            store.trackPaymentFailure(context: "deposit_prepare", stripeErrorType: diagnostics.type, stripeErrorCode: diagnostics.code, stripeMessage: diagnostics.detail)
            errorText = Self.paymentFailureText(diagnostics, error: error, developer: store.developerModeEnabled)
        }
    }

    func handleConfirmation(_ result: PaymentSheetResult) {
        switch result {
        case .completed:
            // Not `store.currentIntake.paymentStatus = "paid"`. The device
            // saying the sheet completed is not the same as Stripe having the
            // money — the confirmation can arrive here and never reach
            // Stripe, and a client that can mark itself paid is a client that
            // can lie. The webhook writes the row; this asks what it says.
            errorText = ""
            Task { await store.refreshDepositStatus() }
        case .canceled:
            errorText = ""
        case .failed(let error):
            // See DepositSection.stripeFailureDiagnostics: `error.localizedDescription`
            // alone is Stripe's own generic fallback for most of
            // STPPaymentHandler's failure codes, which is why this used to
            // read the same vague sentence for every distinct cause.
            let diagnostics = Self.stripeFailureDiagnostics(error)
            store.trackPaymentFailure(context: "deposit", stripeErrorType: diagnostics.type, stripeErrorCode: diagnostics.code, stripeMessage: diagnostics.detail)
            errorText = Self.paymentConfirmText(diagnostics, error: error, developer: store.developerModeEnabled)
        }
    }

    #else

    /// The path taken by the default build (no `TIMI_STRIPE`), by the
    /// macOS host build that runs the unit tests, and by the Skip/Android
    /// build until the Stripe Android SDK is gated the same way.
    ///
    /// TODO(android-stripe): wire Stripe's Android SDK behind the same flag.
    /// The Worker side is complete and surface-agnostic — the deposit intent
    /// arrives from `POST /api/intakes/{id}/payment-intent` with a client
    /// secret and a publishable key, and `payment_intent.succeeded` on the
    /// webhook is what marks it paid — so the Android work is confined to
    /// this file's `#else` branch plus a `com.stripe:paymentsheet` Gradle
    /// dependency in Sources/TimiNowUI/Skip/skip.yml. It is not done here
    /// because skipstone would have to transpile a Swift `#if` branch that
    /// references Kotlin-only types, which the current Skip toolchain cannot
    /// express, and guessing at it would break the Android build for everyone
    /// rather than leaving it where it already is.
    @ViewBuilder
    var elementsControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Card payment is not available in this build.")
                .font(.caption).fontWeight(.bold)
            Text("The clinic is holding your arrival either way. Pay the deposit at the desk, or open Tími on iOS to pay now.")
                .font(.caption).foregroundStyle(TimiColor.muted)
        }
    }

    func prepareElements() async { }

    #endif
}
