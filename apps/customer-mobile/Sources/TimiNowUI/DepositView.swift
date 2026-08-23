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
#endif

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

            if !isPaid { collectionControls }

            if !errorText.isEmpty {
                Text(errorText).font(.caption).foregroundStyle(TimiColor.coral)
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
                await prepareElements()
            }
        }
    }

    @ViewBuilder
    var collectionControls: some View {
        if store.depositBusy {
            Text("Preparing a secure payment…").font(.caption).foregroundStyle(TimiColor.muted)
        } else if store.depositIntent?.mode == "demo" {
            // A build with no Stripe credentials. Saying so is the honest
            // thing: a card field here would be asking somebody for a card
            // number that goes nowhere.
            Text("This is a demonstration build. No card is collected and no money moves.")
                .font(.caption).foregroundStyle(TimiColor.muted)
        } else {
            elementsControls
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

    func prepareElements() async {
        guard let intent = store.depositIntent, intent.mode == "stripe",
              let secret = intent.clientSecret, let publishable = intent.publishableKey else { return }
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

        let created: PaymentSheet.FlowController? = await withCheckedContinuation { continuation in
            PaymentSheet.FlowController.create(paymentIntentClientSecret: secret, configuration: configuration) { result in
                switch result {
                case .success(let controller): continuation.resume(returning: controller)
                case .failure: continuation.resume(returning: nil)
                }
            }
        }
        if let created {
            flowController = created
            paymentOptionLabel = created.paymentOption?.label ?? ""
        } else {
            errorText = "Tími could not open a secure payment. Try again in a moment."
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
            errorText = error.localizedDescription
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
