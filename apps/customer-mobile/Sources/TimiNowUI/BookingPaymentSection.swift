import Foundation
import SwiftUI
import TimiNowCore

// Same Stripe Elements gating as DepositView.swift, and for the same
// reasons — StripePaymentSheet is Apple-only, skipstone cannot transpile it,
// and it only enters the package manifest when TIMI_STRIPE=1 is set. With
// the flag unset — the default everywhere including CI — this file compiles
// to the fallback path below.
#if canImport(StripePaymentSheet) && !SKIP && os(iOS)
import StripePaymentSheet
import UIKit
#endif

/// The combined booking-payment section of the tracker.
///
/// Before this existed, choosing a clinic revealed its address, phone, map
/// and Navigate button for free — the only payment prompt on screen was a
/// separate, optional arrival-deposit card, which is why customers kept
/// seeing "no deposit required" even though Tími's own service fee was never
/// actually collected. This section is what the tracker now shows *instead*
/// of clinic details until the combined charge — the service fee, bundled
/// with any clinic-required arrival deposit as one card charge — is settled.
/// See `TrackerView.body` for the gating and `AppStore.bookingPaymentSettled`
/// for what "settled" means.
///
/// Built the same way `DepositSection` is: `PaymentSheet.FlowController`
/// mounted on Tími's own screen, under Tími's own heading and confirm
/// button — never Checkout, never a hosted page. `DepositSection.appearance`
/// is reused as-is rather than duplicated.
struct BookingPaymentSection: View {
    @Bindable var store: AppStore

    // Not `@State private`: Skip cannot bridge private SwiftUI state, and
    // scripts/validate-native.mjs fails the build over it. See
    // DepositSection's own `errorText` for the same note.
    @State var errorText: String = ""

    #if canImport(StripePaymentSheet) && !SKIP && os(iOS)
    @State var flowController: PaymentSheet.FlowController?
    @State var paymentOptionLabel: String = ""
    #endif

    var payment: BookingPaymentOrder? { store.bookingPayment }
    var mode: String { payment?.mode ?? "" }
    var allocations: [BookingPaymentAllocation] { payment?.order?.allocations ?? [] }
    var totalCents: Int { payment?.totalCents ?? payment?.order?.totalCents ?? 0 }

    var body: some View {
        Group {
            if mode == "no_charge" {
                noChargeNotice
            } else {
                paymentCard
            }
        }
        .timiCard(TimiColor.goldSoft)
        .task {
            // TrackerView's own `.onAppear` already asks for this once the
            // tracker shows; asking again here too — guarded the same way,
            // on `store.bookingPayment == nil` — means this section works
            // correctly even if it is ever reached before that fires, and
            // costs nothing when it isn't, since the Worker's own idempotent
            // order lookup makes a repeat ask harmless.
            if store.bookingPayment == nil {
                await store.prepareBookingPayment()
                if store.bookingPayment == nil {
                    // prepareBookingPayment swallows its own failure into a
                    // silent report — the customer is standing there with a
                    // sick animal, not somewhere to hand a stack trace — so a
                    // still-nil order here is the only place left to say
                    // anything at all.
                    errorText = "Tími could not reach the payment service. Try again in a moment."
                }
            }
            if store.bookingPayment?.mode == "stripe" {
                await prepareElements()
            }
        }
    }

    /// A sponsored booking with no clinic deposit owed totals zero, and zero
    /// is not a charge — nothing to collect, nothing to show a card field
    /// for. Worded to match the Paw It Forward Fund's own tone elsewhere in
    /// the app (see `HardshipViews.swift`'s "YOU'RE COVERED" card).
    var noChargeNotice: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill").font(.title2).foregroundStyle(TimiColor.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text("Nothing to pay").font(.headline)
                Text("Your Paw It Forward Fund coverage takes care of this — no card needed.")
                    .font(.caption).foregroundStyle(TimiColor.muted)
            }
        }
    }

    var paymentCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            Eyebrow(text: "CONFIRM YOUR VISIT", color: TimiColor.blue)
            HStack {
                Text(TimiFormat.money(totalCents)).font(.system(size: 34, weight: .bold, design: .serif))
                Spacer()
                Image(systemName: "creditcard.fill").font(.title).foregroundStyle(TimiColor.blue)
            }
            if !allocations.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(allocations, id: \.id) { allocation in
                        HStack {
                            Text(lineLabel(for: allocation.purpose)).font(.caption).foregroundStyle(TimiColor.ink)
                            Spacer()
                            Text(TimiFormat.money(allocation.amountCents)).font(.caption).fontWeight(.semibold).foregroundStyle(TimiColor.ink)
                        }
                    }
                }
            }
            Text("This unlocks the clinic's address, phone number, and turn-by-turn directions.")
                .font(.caption).foregroundStyle(TimiColor.muted)

            collectionControls

            if !errorText.isEmpty {
                Text(errorText).font(.caption).foregroundStyle(TimiColor.coral)
            }
        }
    }

    func lineLabel(for purpose: String) -> String {
        switch purpose {
        case "OWNER_PLATFORM_FEE": return "Tími service fee"
        case "CLINIC_DEPOSIT": return "Clinic arrival deposit"
        default: return purpose.capitalized
        }
    }

    @ViewBuilder
    var collectionControls: some View {
        if store.bookingPaymentBusy || payment == nil {
            Text("Preparing a secure payment…").font(.caption).foregroundStyle(TimiColor.muted)
        } else if mode == "demo" {
            // A build with no Stripe credentials. Saying so is the honest
            // thing: a card field here would be asking somebody for a card
            // number that goes nowhere. In practice this is on screen for at
            // most an instant — `demo` is one of the modes
            // `AppStore.bookingPaymentSettled` treats as settled, so
            // `TrackerView` swaps to clinic details on the very next redraw.
            Text("This is a demonstration build. No card is collected and no money moves.")
                .font(.caption).foregroundStyle(TimiColor.muted)
        } else if mode == "stripe" {
            elementsControls
        } else {
            // "paid" — settled on an earlier poll faster than this render
            // caught up, or "no_charge" (handled a level up in `body`
            // instead). `TrackerView` unmounts this section as soon as
            // `bookingPaymentSettled` is true, so this is only ever visible
            // for the same instant as the demo branch above.
            Text("This has already been paid.").font(.caption).foregroundStyle(TimiColor.muted)
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
                    Text("Pay \(TimiFormat.money(totalCents)) and see clinic details")
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
        guard let intent = store.bookingPayment, intent.mode == "stripe" else { return }
        guard let secret = intent.clientSecret, let publishable = intent.publishableKey else {
            // mode == "stripe" is the Worker promising a real PaymentIntent
            // exists; missing either field here is the Worker's contract
            // broken, not a state elementsControls should sit on forever.
            errorText = "Tími could not open a secure payment. Try again in a moment."
            return
        }
        // Set from the Worker's response rather than compiled in, so
        // rotating the key does not need an App Store release.
        STPAPIClient.shared.publishableKey = publishable

        var configuration = PaymentSheet.Configuration()
        configuration.merchantDisplayName = "Tími NOW"
        // Tími is the merchant of record — the platform takes the charge and
        // pays the clinic separately afterwards — so this is deliberately
        // not the clinic's name.
        configuration.allowsDelayedPaymentMethods = false
        configuration.returnURL = "timinow://stripe-redirect"
        // Reused directly rather than duplicated — see DepositSection.
        configuration.appearance = DepositSection.appearance

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
            // Not writing "paid" locally. The device saying the sheet
            // completed is not the same as Stripe having the money — the
            // confirmation can arrive here and never reach Stripe, and a
            // client that can mark itself paid is a client that can lie.
            // `prepareBookingPayment` re-polls the same idempotent endpoint;
            // the webhook is what actually moves the order to PAID, and this
            // just asks what it says now. Once it says PAID, `TrackerView`
            // reveals clinic details and this section unmounts itself.
            errorText = ""
            Task { await store.prepareBookingPayment() }
        case .canceled:
            errorText = ""
        case .failed(let error):
            errorText = error.localizedDescription
        }
    }

    #else

    /// The path taken by the default build (no `TIMI_STRIPE`), by the macOS
    /// host build that runs the unit tests, and by the Skip/Android build
    /// until the Stripe Android SDK is gated the same way — see
    /// DepositSection's own `#else` branch for the full note.
    @ViewBuilder
    var elementsControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Card payment is not available in this build.")
                .font(.caption).fontWeight(.bold)
            Text("Pay at the desk, or open Tími on iOS to pay now and see clinic details.")
                .font(.caption).foregroundStyle(TimiColor.muted)
        }
    }

    func prepareElements() async { }

    #endif
}
