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
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack { Button { store.route = .home } label: { Image(systemName: "xmark").frame(width: 42, height: 42).background(.white, in: Circle()) }; Spacer(); ProgressPills(current: step, total: 2); Spacer().frame(width: 42) }
                    Eyebrow(text: step == 0 ? "1 OF 2 · OBSERVABLE CONCERN" : "2 OF 2 · CONTACT + CONSENT")
                    Text(step == 0 ? "What is happening with \(store.draft.pet.name)?" : "Where should clinics reach you?").font(.system(size: 38, weight: .bold, design: .serif))
                    if step == 0 { concernStep } else { contactStep }
                    HStack(spacing: 12) {
                        if step > 0 { Button("Back") { withAnimation { step = 0 } }.buttonStyle(TimiQuietButtonStyle()) }
                        Button {
                            if step == 0 { if store.concernValidation.isReady { withAnimation { step = 1 } } else { store.errorMessage = store.concernValidation.issues.first } }
                            else { Task { await store.startSearch() } }
                        } label: { HStack { if store.isWorking { ProgressView().tint(.white) }; Text(step == 0 ? "Continue" : "Ask nearby clinics"); Image(systemName: "arrow.right") } }
                            .buttonStyle(TimiPrimaryButtonStyle()).disabled(store.isWorking || (step == 1 && (!store.draft.legalConsent || !store.draft.contactConsent)))
                    }
                }.padding(20).padding(.bottom, 30)
            }.background(TimiColor.canvas)
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
    func acknowledgement(_ binding: Binding<Bool>, _ text: String) -> some View { Toggle(isOn: binding) { Text(text).font(.caption).fontWeight(.semibold) }.toggleStyle(.switch).tint(TimiColor.blue) }
}
