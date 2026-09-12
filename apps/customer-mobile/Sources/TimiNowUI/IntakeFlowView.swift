import Foundation
import Observation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

struct IntakeFlowView: View {
    @Bindable var store: AppStore
    @State var step = 0
    let symptoms = [
        ("vomiting_or_diarrhea", "Vomiting / diarrhea", "drop.fill"), ("breathing_or_coughing", "Breathing / coughing", "lungs.fill"),
        ("pain_or_limping", "Pain / limping", "figure.walk"), ("not_eating_or_drinking", "Not eating / drinking", "fork.knife"),
        ("urination_or_stool", "Bathroom change", "exclamationmark.circle"), ("injury_or_bleeding", "Injury / bleeding", "bandage.fill"),
        ("energy_or_behavior", "Energy / behavior", "bolt.heart.fill"), ("eye_ear_or_skin", "Eye / ear / skin", "eye.fill")
    ]

    var body: some View {
        NavigationStack {
            ScrollViewReader { scrollProxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        HStack { Button { store.route = .home } label: { Image(systemName: "xmark").frame(width: 42, height: 42).background(.white, in: Circle()) }; Spacer(); ProgressPills(current: step, total: 2); Spacer().frame(width: 42) }
                            .timiMorph(0)
                        // `.id(step)` gives the eyebrow and headline a fresh
                        // identity per step, so moving between steps morphs
                        // them out and in — with their own text — instead of
                        // hard-swapping the words in place. The route change
                        // out of this screen morphs everything regardless.
                        VStack(alignment: .leading, spacing: 20) {
                            Eyebrow(text: step == 0 ? "1 OF 2 · OBSERVABLE CONCERN" : "2 OF 2 · CONTACT + CONSENT")
                            DisplayHeadline(text: step == 0 ? "What is happening with \(store.draft.pet.name)?" : "Where should clinics reach you?", size: 38)
                        }
                        .id("intake-heading-\(step)")
                        .timiMorph(1)
                        if step == 0 { concernStep.timiMorph(2) } else { contactStep.timiMorph(2) }
                        HStack(spacing: 12) {
                            if step > 0 { Button("Back") { changeStep(to: 0, proxy: scrollProxy) }.buttonStyle(TimiQuietButtonStyle()) }
                            Button {
                                if step == 0 { if store.concernValidation.isReady { changeStep(to: 1, proxy: scrollProxy) } else { store.errorMessage = store.concernValidation.issues.first } }
                                else {
                                    // Same rule as changeStep: the search
                                    // screen's fly-in should not share the
                                    // stage with a departing keyboard.
                                    TimiKeyboard.dismiss()
                                    Task { await store.startSearch() }
                                }
                            } label: { HStack { if store.isWorking { ProgressView().tint(.white) }; Text(step == 0 ? "Continue" : "Ask nearby clinics"); Image(systemName: "arrow.right") } }
                                .buttonStyle(TimiPrimaryButtonStyle()).disabled(store.isWorking || (step == 1 && (!store.draft.legalConsent || !store.draft.contactConsent)))
                        }
                        .timiMorph(3)
                    }.padding(20).padding(.bottom, 30).id("flowTop")
                        // A form column, not a wall: fold-open and landscape
                        // widths keep the fields a comfortable reading width.
                        .frame(maxWidth: 720)
                        .frame(maxWidth: .infinity)
                }.timiScrollFits().background(TimiColor.canvas)
            }
        }
    }

    /// `concernStep` and `contactStep` are wildly different heights — the
    /// symptom grid alone is taller than `contactStep`'s three text fields —
    /// so animating `step` alone left the ScrollView's offset pointing past
    /// the newly-short content: the coral button's own label swap animated
    /// smoothly, then the whole page yanked down to where the clamped offset
    /// now landed. Scrolling back to the top in the same animation block is
    /// what keeps that snap from happening.
    ///
    /// The keyboard leaves first, then the morph runs. With a text field
    /// focused (the concern editor, the contact fields), changing steps
    /// while the keyboard was still up ran the element fly-out and the
    /// keyboard's own dismissal at the same time — two large animations
    /// fighting over the same screen height, which read as no choreography
    /// at all. The short beat lets the keyboard get most of the way out
    /// before the elements move; with no keyboard up it is imperceptible.
    private func changeStep(to value: Int, proxy: ScrollViewProxy) {
        TimiKeyboard.dismiss()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 140_000_000)
            // The same snappy register as route changes — the default ease
            // here read as sluggish next to them.
            withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) { step = value; proxy.scrollTo("flowTop", anchor: .top) }
        }
    }

    var concernStep: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Choose everything you can observe").font(.headline)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 145))], spacing: 10) {
                ForEach(symptoms, id: \.0) { item in
                    let selected = store.draft.symptomKeys.contains(item.0)
                    Button { if selected { store.draft.symptomKeys.removeAll(where: { $0 == item.0 }) } else { store.draft.symptomKeys.append(item.0) } } label: { HStack(spacing: 8) { Image(systemName: item.2); Text(item.1).font(.caption).fontWeight(.bold); Spacer() }.padding(12).frame(minHeight: 54).background(selected ? TimiColor.blueSoft : .white, in: RoundedRectangle(cornerRadius: 15)).overlay(RoundedRectangle(cornerRadius: 15).stroke(selected ? TimiColor.blue : TimiColor.ink.faded(0.14), lineWidth: CGFloat(selected ? 2 : 1))) }.buttonStyle(.plain)
                }
            }
            // Five choices, not a text field. The Worker validates this against
            // a closed set and rejects everything else with "Choose when the
            // concern started", so "around 7 AM today" — the placeholder this
            // used to show — could never be accepted.
            VStack(alignment: .leading, spacing: 8) {
                Text("When did it begin?").font(.headline)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 145))], spacing: 10) {
                    ForEach(ConcernOnset.allCases, id: \.self) { onset in
                        let selected = store.draft.startedWhen == onset.rawValue
                        Button { store.draft.startedWhen = selected ? "" : onset.rawValue } label: {
                            HStack(spacing: 8) {
                                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                                Text(onset.title).font(.caption).fontWeight(.bold)
                                Spacer()
                            }
                            .padding(12)
                            .frame(minHeight: 54)
                            .background(selected ? TimiColor.blueSoft : .white, in: RoundedRectangle(cornerRadius: 15))
                            .overlay(RoundedRectangle(cornerRadius: 15).stroke(selected ? TimiColor.blue : TimiColor.ink.faded(0.14), lineWidth: CGFloat(selected ? 2 : 1)))
                        }.buttonStyle(.plain)
                    }
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack { Text("What exactly have you noticed?").font(.headline); Spacer(); Text("\(store.concernValidation.score)% specific").font(.caption).fontWeight(.black).foregroundStyle(store.concernValidation.isReady ? TimiColor.blue : TimiColor.coral) }
                TextEditor(text: $store.draft.summary).frame(minHeight: 128).timiFieldMultiline()
                Text("Useful: “Milo vomited three times since 7 AM and will not drink.” Not enough: “He isn't acting like himself.”").font(.caption).foregroundStyle(TimiColor.muted)
                if let issue = store.concernValidation.issues.first { Label(issue, systemImage: "info.circle.fill").font(.caption).foregroundStyle(TimiColor.coral).padding(10).background(TimiColor.coralSoft, in: RoundedRectangle(cornerRadius: 12)) }
            }
            VStack(alignment: .leading, spacing: 10) { Text("How quickly are you looking for care?").font(.headline); ForEach(CareUrgency.allCases, id: \.self) { urgency in Button { store.draft.urgency = urgency } label: { HStack { Image(systemName: store.draft.urgency == urgency ? "largecircle.fill.circle" : "circle").foregroundStyle(urgency == .emergency ? TimiColor.coral : TimiColor.blue); Text(urgency.title).fontWeight(.semibold); Spacer() }.padding(13).background(.white, in: RoundedRectangle(cornerRadius: 14)) }.buttonStyle(.plain) } }
            // The moment somebody says "emergency" is the moment the list is
            // worth offering, whether or not they finish this form.
            if store.draft.urgency == .emergency { SafetyBanner(store: store) }
        }
    }

    var contactStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 7) {
                fieldLabel("Your name")
                TextField("Your full name", text: $store.draft.ownerName).textContentType(.name).timiField()
            }
            VStack(alignment: .leading, spacing: 7) {
                fieldLabel("Mobile number")
                TextField("(510) 555-0123", text: $store.draft.ownerPhone)
                    .textContentType(.telephoneNumber).timiKeyboard(.phone).timiField()
            }
            VStack(alignment: .leading, spacing: 7) {
                fieldLabel("Email (optional)")
                TextField("you@example.com", text: $store.draft.ownerEmail)
                    .textContentType(.emailAddress).timiKeyboard(.email)
                    .autocorrectionDisabled().timiField()
            }
            VStack(alignment: .leading, spacing: 10) { Eyebrow(text: "BEFORE WE CONTACT CLINICS"); acknowledgement($store.draft.contactConsent, "I authorize Tími and contacted participating clinics to call or text me about this care request."); acknowledgement($store.draft.legalConsent, "I agree to the Terms, Privacy Notice, Veterinary Safety Notice, and the selected clinic's displayed policy.") }.timiCard(TimiColor.paper)
            // Named specifically when there is something to name. A blanket
            // "your structured intake" does not tell somebody that the
            // medication list they typed into a pet profile weeks ago is about
            // to reach thirty clinics.
            Text(sharingNotice).font(.caption).foregroundStyle(TimiColor.muted)
            NavigationLink { LegalView() } label: { Label("Read legal and veterinary safety notices", systemImage: "doc.text.fill").font(.callout).fontWeight(.bold).foregroundStyle(TimiColor.blue) }
        }
    }

    /// The fields these label used `.roundedBorder` — the system's grey
    /// hairline — which next to a coral button with a 2pt ink border and a
    /// five-point drop reads as a different app's screen. They are written out
    /// rather than shared through a helper because a helper would have to name
    /// UIKeyboardType in its signature, and that type does not exist on the
    /// Android side of this module.
    func fieldLabel(_ title: String) -> some View { Text(title).font(.headline) }

    var sharingNotice: String {
        let base = "Your structured intake may be shared with up to 30 matching participating clinics so they can respond. You may compare up to five active offers. Only the clinic you select is confirmed."
        var recorded: [String] = []
        if !store.draft.pet.allergies.isEmpty { recorded.append("allergies") }
        if !store.draft.pet.medications.isEmpty { recorded.append("medications") }
        guard !recorded.isEmpty else { return base }
        return base + " That includes the \(recorded.joined(separator: " and ")) recorded on \(store.draft.pet.name)'s profile, which are unverified and shared exactly as you wrote them. Edit them under Pets."
    }
    /// The Tími switch (Components.swift) instead of the system toggle: the
    /// two consent rows were the last stock-grey controls in the intake flow.
    func acknowledgement(_ binding: Binding<Bool>, _ text: String) -> some View {
        Button {
            withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) { binding.wrappedValue.toggle() }
        } label: {
            HStack(alignment: .center, spacing: 12) {
                Text(text).font(.caption).fontWeight(.semibold).multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                TimiToggle(isOn: binding)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .timiToggleAccessibility(label: text, isOn: binding.wrappedValue)
    }
}
