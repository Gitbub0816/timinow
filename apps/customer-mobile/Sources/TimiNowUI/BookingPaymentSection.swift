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
    @State var customGiftText: String = ""
    @State var showCustomGiftField = false

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
        // Changing the Paw It Forward gift re-prices the order: the Worker
        // cancels the old PaymentIntent and mints one for the new total, so
        // the secret this section's Stripe controller was built around is
        // dead the moment this value moves. Rebuild against the new one.
        .onChange(of: store.bookingPayment?.clientSecret) { _ in
            guard store.bookingPayment?.mode == "stripe" else { return }
            // Drop the stale controller before the rebuild, not after: a
            // confirm button still wired to the old secret during the gap
            // would offer the old total (the charge itself is safe — the
            // Worker cancelled the old PaymentIntent — but the button would
            // be a lie until it failed).
            resetElements()
            Task { await prepareElements() }
        }
        // "I need help paying" can end in an approval while this card is
        // still on screen underneath the pushed application flow. Re-asking
        // the Worker is all it takes: the poll notices the active grant,
        // retires the fee-charging quote, and re-prices — usually to
        // nothing owed, which settles the card away entirely.
        .onChange(of: store.hardshipView?.status) { status in
            guard status == "APPROVED" else { return }
            Task { await store.prepareBookingPayment() }
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

            if mode == "stripe" {
                giftPicker
            }

            collectionControls

            // Deliberately quiet, deliberately here: somebody who cannot
            // afford this charge is standing on this exact screen, not in
            // Settings. It pushes the same Paw It Forward Fund application
            // Settings offers; an approval mid-flow reaches this card
            // through the `.onChange` below.
            NavigationLink { HardshipEntryView(store: store) } label: {
                Text("I need help paying")
                    .font(.caption).fontWeight(.bold)
                    .foregroundStyle(TimiColor.blue)
                    .underline()
            }
            .buttonStyle(.plain)

            if !errorText.isEmpty {
                Text(errorText).font(.caption).foregroundStyle(TimiColor.coral)
            }
        }
    }

    func lineLabel(for purpose: String) -> String {
        switch purpose {
        case "OWNER_PLATFORM_FEE": return "Tími service fee"
        case "CLINIC_DEPOSIT": return "Clinic arrival deposit"
        case "FUND_CONTRIBUTION": return "Paw It Forward gift"
        default: return purpose.capitalized
        }
    }

    /// The whole-dollar amounts offered as one-tap gifts, in cents. Zero is
    /// the first chip on purpose — a gift must be exactly as easy to remove
    /// as to add, or it isn't a gift.
    static let giftChoices: [(Int, String)] = [(0, "No gift"), (200, "$2"), (500, "$5"), (1000, "$10")]

    /// A gift entered through the custom field rather than a preset chip.
    var customGiftSelected: Bool {
        let cents = store.bookingContributionCents
        return cents > 0 && !Self.giftChoices.contains(where: { $0.0 == cents })
    }

    /// An optional Paw It Forward gift, folded into the same single charge.
    /// The chips re-price the order server-side, so the total above and the
    /// pay button's label always show the real amount about to be charged —
    /// never a locally-added number the charge could disagree with.
    var giftPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: "PAW IT FORWARD", color: TimiColor.coral)
            Text("Add a gift to help cover a visit for a pet whose family can't afford one right now.")
                .font(.caption).foregroundStyle(TimiColor.muted)
            HStack(spacing: 8) {
                ForEach(Self.giftChoices, id: \.0) { choice in
                    giftChip(cents: choice.0, label: choice.1)
                }
                customGiftChip
            }
            if showCustomGiftField {
                customGiftEntry
            }
            Text("Gifts go to the Paw It Forward Fund. Not represented as tax deductible.")
                .font(.system(size: 10)).foregroundStyle(TimiColor.muted)
        }
        .padding(.vertical, 4)
    }

    /// Shows the chosen custom amount once one is set, so "Other" doesn't
    /// read as unselected while a $25 gift is actually on the order.
    var customGiftChip: some View {
        let selected = customGiftSelected
        return Button {
            showCustomGiftField.toggle()
        } label: {
            Text(selected ? TimiFormat.money(store.bookingContributionCents) : "Other")
                .font(.system(size: 13, weight: .black))
                .foregroundStyle(selected ? Color.white : TimiColor.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: 38)
                .background(Capsule().fill(selected ? TimiColor.coral : Color.white))
                .overlay(Capsule().stroke(selected ? TimiColor.ink : TimiColor.ink.faded(0.2), lineWidth: CGFloat(selected ? 2 : 1)))
        }
        .buttonStyle(.plain)
        .disabled(store.bookingPaymentBusy)
        .accessibilityLabel("Choose your own gift amount")
    }

    /// Whole dollars only — the Worker refuses anything else, so the field
    /// doesn't pretend cents are an option.
    var customGiftEntry: some View {
        HStack(spacing: 8) {
            Text("$").font(.system(size: 17, weight: .black)).foregroundStyle(TimiColor.ink)
            TextField("Amount", text: $customGiftText)
                .timiKeyboard(.number)
                .timiField()
            Button("Add") {
                guard let dollars = Int(customGiftText.trimmingCharacters(in: .whitespaces)), dollars > 0 else {
                    errorText = "Enter a whole-dollar amount, like 25."
                    return
                }
                errorText = ""
                showCustomGiftField = false
                Task { await store.setBookingContribution(dollars * 100) }
            }
            .buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.coral))
            .disabled(store.bookingPaymentBusy)
        }
    }

    func giftChip(cents: Int, label: String) -> some View {
        let selected = store.bookingContributionCents == cents
        return Button {
            guard !selected else { return }
            Task { await store.setBookingContribution(cents) }
        } label: {
            Text(label)
                .font(.system(size: 13, weight: .black))
                .foregroundStyle(selected ? Color.white : TimiColor.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: 38)
                .background(Capsule().fill(selected ? TimiColor.coral : Color.white))
                .overlay(Capsule().stroke(selected ? TimiColor.ink : TimiColor.ink.faded(0.2), lineWidth: CGFloat(selected ? 2 : 1)))
        }
        .buttonStyle(.plain)
        .disabled(store.bookingPaymentBusy)
        .accessibilityLabel(cents == 0 ? "No Paw It Forward gift" : "Add a \(label) Paw It Forward gift")
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

    func resetElements() {
        flowController = nil
        paymentOptionLabel = ""
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

    func resetElements() { }

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
