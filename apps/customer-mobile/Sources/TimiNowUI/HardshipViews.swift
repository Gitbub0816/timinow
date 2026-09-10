import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif
#if os(iOS) && !SKIP
import PhotosUI
import UniformTypeIdentifiers
import UIKit
#endif

/// The "Paw It Forward Fund" financial-hardship flow, in Tími's own hand.
///
/// Three screens, pushed with plain `NavigationLink`s the same way
/// `SettingsView` already pushes `LegalView` — there is no separate
/// multi-step flow mechanism in this app to reuse (the intake/search/tracker
/// flow is driven by `AppStore.route` because it replaces the whole tab bar;
/// this flow does not, so it stays inside whichever `NavigationStack` hosts
/// Settings):
///
///   HardshipEntryView ──▶ HardshipApplicationView ──▶ (same view, by state)
///     eligibility check      household intake, then         decision screens
///                             evidence + identity + submit
///
/// `HardshipApplicationView` does not push a fourth screen for the decision —
/// it switches on `store.hardshipView?.status` in place, because there is
/// nothing left to navigate to once a decision exists and because the Worker
/// itself treats VERIFYING/DRAFT/PENDING/APPROVED/NOT_VERIFIED as one
/// resource, not five.
struct HardshipEntryView: View {
    @Bindable var store: AppStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Eyebrow(text: "PAW IT FORWARD FUND")
                DisplayHeadline(text: "Financial\nassistance", size: 40)
                Text("If money is the only reason you would skip care right now, the Paw It Forward Fund may cover Tími's service fee. It takes a quick identity check and one supporting document.")
                    .font(.title3).foregroundStyle(TimiColor.muted)
                content
                if let error = store.hardshipError {
                    Text(error).font(.caption).foregroundStyle(TimiColor.coral)
                }
                Text("A decision reflects what you attach and does not consider anything else about your account. Human review is available if you believe a decision was wrong — see the next screen.")
                    .font(.caption).foregroundStyle(TimiColor.muted)
            }
            .padding(20).padding(.bottom, 40)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .timiScrollFits()
        .background(TimiColor.canvas)
        .navigationTitle("Paw It Forward Fund")
        .task { if store.hardshipEligibility == nil { await store.loadHardshipEligibility() } }
    }

    @ViewBuilder var content: some View {
        if store.hardshipBusy && store.hardshipEligibility == nil {
            HStack(spacing: 10) { ProgressView(); Text("Checking eligibility…").font(.callout).foregroundStyle(TimiColor.muted) }
                .padding(.vertical, 20)
        } else if let grant = store.hardshipEligibility?.grant, store.hardshipEligibility?.eligible == true {
            activeGrantCard(grant)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 8) {
                    MetricChip(title: "Standard fee", value: TimiFormat.money(store.hardshipEligibility?.standardOwnerFeeCents))
                    MetricChip(title: "If approved", value: "Covered", color: TimiColor.goldSoft)
                }
                NavigationLink { HardshipApplicationView(store: store) } label: {
                    Label("Start an application", systemImage: "heart.text.square.fill")
                }.buttonStyle(TimiPrimaryButtonStyle())
            }
        }
    }

    func activeGrantCard(_ grant: HardshipGrant) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: "YOU'RE COVERED", color: TimiColor.blue)
            Text("Your next eligible booking is sponsored.").font(.title3).fontWeight(.black)
            HStack(spacing: 8) {
                if let expires = grant.expiresAt { MetricChip(title: "Expires", value: HardshipFormat.shortDate(expires)) }
                if let limit = grant.sponsoredVisitLimit, let used = grant.sponsoredVisitsUsed {
                    MetricChip(title: "Visits left", value: "\(max(0, limit - used))", color: TimiColor.goldSoft)
                }
            }
            Text("No new application is needed while this is active.").font(.caption).foregroundStyle(TimiColor.muted)
        }.timiCard(TimiColor.blueSoft)
    }
}

/// Household intake, then whichever of the in-progress/decision states
/// applies. `store.hardshipApplication == nil` is what separates the two —
/// there is no dedicated "creating" sub-state to track.
struct HardshipApplicationView: View {
    @Bindable var store: AppStore
    @State var householdSize = 1
    @State var attested = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Eyebrow(text: "PAW IT FORWARD FUND")
                DisplayHeadline(text: "Apply for\nassistance", size: 38)
                content
            }
            .padding(20).padding(.bottom, 40)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(TimiColor.canvas)
        .navigationTitle("Application")
    }

    @ViewBuilder var content: some View {
        if store.hardshipApplication == nil {
            householdForm
        } else if let view = store.hardshipView {
            switch view.status {
            case "APPROVED": HardshipApprovedView(view: view)
            case "NOT_VERIFIED": HardshipDeniedView(store: store, view: view)
            case "PENDING": HardshipPendingView(view: view)
            default: HardshipInProgressView(store: store)
            }
        } else {
            HardshipInProgressView(store: store)
        }
    }

    var householdForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Tell us about your household. You will add one supporting document and verify your identity next.")
                .font(.callout).foregroundStyle(TimiColor.muted)
            VStack(alignment: .leading, spacing: 8) {
                Text("People in your household").font(.headline)
                // The Tími stepper and switch (Components.swift) in place of
                // the system Stepper and Toggle — the two stock-grey controls
                // this form still showed.
                TimiStepper(value: $householdSize, lowerBound: 1, upperBound: 12, label: "\(householdSize) \(householdSize == 1 ? "person" : "people")")
            }
            TimiToggleRow(title: "I attest that this household size is accurate.", subtitle: nil, isOn: $attested)
            if let error = store.hardshipError { Text(error).font(.caption).foregroundStyle(TimiColor.coral) }
            Button {
                Task { await store.startHardshipApplication(householdSize: householdSize, householdAttested: attested) }
            } label: {
                HStack { if store.hardshipBusy { ProgressView().tint(.white) }; Text("Start application") }
            }
            .buttonStyle(TimiPrimaryButtonStyle())
            .disabled(!attested || store.hardshipBusy)
        }.timiCard(Color.white)
    }
}

/// Household summary (read-only — there is no route to change it once the
/// application exists), evidence, identity, and submit.
struct HardshipInProgressView: View {
    @Bindable var store: AppStore

    var canSubmit: Bool { !store.hardshipEvidence.isEmpty && !store.hardshipBusy }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            householdSummary
            HardshipEvidenceSection(store: store)
            HardshipIdentitySection(store: store)
            submitControls
            if let error = store.hardshipError { Text(error).font(.caption).foregroundStyle(TimiColor.coral) }
        }
    }

    var householdSummary: some View {
        HStack {
            Image(systemName: "person.2.fill").foregroundStyle(TimiColor.blue)
            Text(householdLine).font(.callout).fontWeight(.semibold)
            Spacer()
        }.timiCard(Color.white)
    }

    var householdLine: String {
        let size = store.hardshipApplication?.householdSize.map { "\($0) in household" } ?? "Household size not given"
        return store.hardshipApplication?.householdAttested == true ? "\(size) · attested" : size
    }

    var submitControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Task { await store.submitHardshipApplication() }
            } label: {
                HStack { if store.hardshipBusy { ProgressView().tint(.white) }; Text("Submit application") }
            }
            .buttonStyle(TimiPrimaryButtonStyle())
            .disabled(!canSubmit)
            Text("Add at least one supporting document before submitting. Tími decides using only what you attach here.")
                .font(.caption).foregroundStyle(TimiColor.muted)
        }
    }
}

// MARK: - Evidence

/// Add-a-document flow: pick a type, then a source. Both pickers are
/// Apple-only frameworks (`PhotosUI`, and `.fileImporter`'s
/// `UniformTypeIdentifiers` types) that nothing else in this codebase has
/// exercised through Skip's Android transpile yet, so — matching this
/// module's existing rule that an unproven Apple-only surface stays behind
/// `#if os(iOS) && !SKIP` (Stripe, Mapbox, WKWebView above) rather than being
/// guessed at — this section offers the picker on iOS only. See the `#else`
/// branch below.
struct HardshipEvidenceSection: View {
    @Bindable var store: AppStore

    #if os(iOS) && !SKIP
    @State var showTypePicker = false
    @State var pendingType: HardshipEvidenceType?
    @State var pendingSource: EvidenceSource?
    @State var showPhotoPicker = false
    @State var showFileImporter = false
    @State var photoSelection: PhotosPickerItem?
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: "SUPPORTING DOCUMENTS")
            if store.hardshipEvidence.isEmpty {
                Text("A benefit letter, a termination notice, pay stubs, or a bill all work.")
                    .font(.caption).foregroundStyle(TimiColor.muted)
            }
            ForEach(store.hardshipEvidence) { item in evidenceRow(item) }
            addEvidenceControls
        }
        .timiCard(Color.white)
        #if os(iOS) && !SKIP
        .confirmationDialog("What kind of document is this?", isPresented: $showTypePicker, titleVisibility: .visible) {
            ForEach(HardshipEvidenceType.allCases, id: \.self) { type in
                Button(type.title) {
                    pendingType = type
                    switch pendingSource {
                    case .photo: showPhotoPicker = true
                    case .file: showFileImporter = true
                    case nil: break
                    }
                }
            }
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoSelection, matching: .images)
        .onChange(of: photoSelection) { newItem in Task { await handlePhotoSelection(newItem) } }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.pdf]) { result in handleFileImport(result) }
        #endif
    }

    func evidenceRow(_ item: HardshipEvidenceSummary) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.fill").foregroundStyle(TimiColor.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.type.title).font(.callout).fontWeight(.bold)
                Text(item.label).font(.caption).foregroundStyle(TimiColor.muted)
            }
            Spacer()
            Image(systemName: "checkmark.circle.fill").foregroundStyle(TimiColor.blue)
        }
        .padding(10)
        .background(TimiColor.blueSoft, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder var addEvidenceControls: some View {
        if store.hardshipBusy {
            HStack(spacing: 8) { ProgressView(); Text("Uploading…").font(.caption).foregroundStyle(TimiColor.muted) }
        } else {
            #if os(iOS) && !SKIP
            HStack(spacing: 10) {
                Button { pendingSource = .photo; showTypePicker = true } label: { Label("Photo", systemImage: "photo.on.rectangle") }
                    .buttonStyle(TimiQuietButtonStyle())
                Button { pendingSource = .file; showTypePicker = true } label: { Label("PDF file", systemImage: "doc.badge.plus") }
                    .buttonStyle(TimiQuietButtonStyle())
            }
            #else
            // TODO(android-evidence-upload): PhotosPicker and .fileImporter
            // are gated on iOS the same as WKWebView (see WebSheetView.swift)
            // — neither has been exercised through skipstone's Kotlin/Compose
            // bridge anywhere in this codebase, and getting that wrong fails
            // silently on the one platform that has the SDK (see the
            // canImport lint in scripts/validate-native.mjs for exactly that
            // failure mode with a different framework). The Worker side needs
            // nothing further: POST .../uploads takes raw bytes and a content
            // type from any client, so closing this gap is confined to
            // Android's own picker and file-read APIs behind this branch.
            Text("Document upload is not yet available in this build. Continue on iOS to attach evidence.")
                .font(.caption).foregroundStyle(TimiColor.muted)
            #endif
        }
    }

    #if os(iOS) && !SKIP
    enum EvidenceSource { case photo, file }

    func handlePhotoSelection(_ item: PhotosPickerItem?) async {
        guard let item, let type = pendingType else { return }
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data),
              let jpeg = image.jpegData(compressionQuality: 0.85) else { return }
        await store.uploadHardshipEvidence(type: type, data: jpeg, contentType: "image/jpeg", label: "Photo")
        photoSelection = nil
        pendingType = nil
    }

    func handleFileImport(_ result: Result<URL, Error>) {
        guard let type = pendingType, case .success(let url) = result else { return }
        Task {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { return }
            await store.uploadHardshipEvidence(type: type, data: data, contentType: "application/pdf", label: url.lastPathComponent)
        }
        pendingType = nil
    }
    #endif
}

// MARK: - Identity

struct HardshipIdentitySection: View {
    @Bindable var store: AppStore
    @State var checking = false

    #if os(iOS) && !SKIP
    @State var showVerifySheet = false
    @State var verifyURL: URL?
    #else
    @State var androidVerifyURL: URL?
    #endif

    var verified: Bool { store.hardshipApplication?.identityVerified == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Eyebrow(text: "IDENTITY VERIFICATION")
            HStack(spacing: 10) {
                Image(systemName: verified ? "checkmark.seal.fill" : "person.crop.circle.badge.questionmark")
                    .foregroundStyle(verified ? TimiColor.blue : TimiColor.muted)
                Text(verified ? "Identity verified" : "Not yet verified").font(.callout).fontWeight(.bold)
                Spacer()
            }
            Text("Tími verifies you are a real, unique person through Didit, a third-party identity service, before an assistance decision is made.")
                .font(.caption).foregroundStyle(TimiColor.muted)
            verifyControls
        }
        .timiCard(TimiColor.paper)
        #if os(iOS) && !SKIP
        .sheet(isPresented: $showVerifySheet) {
            if let verifyURL {
                TimiWebSheet(url: verifyURL, title: "Verify your identity") {
                    showVerifySheet = false
                    Task { checking = true; await store.refreshHardshipIdentityStatus(); checking = false }
                }
            }
        }
        #endif
    }

    @ViewBuilder var verifyControls: some View {
        if checking {
            HStack(spacing: 8) { ProgressView(); Text("Checking verification…").font(.caption).foregroundStyle(TimiColor.muted) }
        } else if verified {
            Text("No further action needed here.").font(.caption).foregroundStyle(TimiColor.muted)
        } else {
            #if os(iOS) && !SKIP
            Button {
                Task { verifyURL = await store.startHardshipIdentityVerification(); showVerifySheet = verifyURL != nil }
            } label: {
                Label("Verify your identity", systemImage: "checkmark.shield.fill")
            }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
            #else
            androidVerifyControls
            #endif
        }
    }

    #if !(os(iOS) && !SKIP)
    @ViewBuilder var androidVerifyControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Task { androidVerifyURL = await store.startHardshipIdentityVerification() }
            } label: {
                Label("Verify your identity", systemImage: "checkmark.shield.fill")
            }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
            if let url = androidVerifyURL {
                Link(destination: url) { Label("Open verification in browser", systemImage: "safari.fill") }
                    .buttonStyle(TimiQuietButtonStyle())
                Button {
                    Task { checking = true; await store.refreshHardshipIdentityStatus(); checking = false }
                } label: {
                    Text("I finished — check status")
                }.buttonStyle(TimiQuietButtonStyle())
            }
        }
    }
    #endif
}

// MARK: - Decision screens

struct HardshipApprovedView: View {
    var view: HardshipApplicantView

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: "ASSISTANCE APPROVED", color: TimiColor.blue)
            Text(view.title ?? "You're approved").font(.system(size: 32, weight: .bold, design: .serif))
            Text(view.message ?? "").font(.callout).foregroundStyle(TimiColor.muted)
            HStack(spacing: 8) {
                if let limit = view.sponsoredVisitLimit { MetricChip(title: "Sponsored visits", value: "\(limit)") }
                if let expires = view.expiresAt { MetricChip(title: "Expires", value: HardshipFormat.shortDate(expires), color: TimiColor.goldSoft) }
            }
        }.timiCard(TimiColor.blueSoft)
    }
}

struct HardshipDeniedView: View {
    @Bindable var store: AppStore
    var view: HardshipApplicantView
    @State var appealSent: String?
    @State var contactEmail = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: "COULD NOT VERIFY", color: TimiColor.coral)
            Text(view.title ?? "We could not verify your hardship").font(.system(size: 30, weight: .bold, design: .serif))
            Text(view.message ?? "").font(.callout).foregroundStyle(TimiColor.muted)
            if let appealSent {
                Text(appealSent).font(.callout).fontWeight(.semibold).foregroundStyle(TimiColor.blue)
            } else {
                TextField("Email for a human to reach you (optional)", text: $contactEmail)
                    .textContentType(.emailAddress).timiKeyboard(.email).autocorrectionDisabled().timiField()
                Button {
                    Task { appealSent = await store.appealHardshipApplication(contactEmail: contactEmail.isEmpty ? nil : contactEmail) }
                } label: {
                    HStack { if store.hardshipBusy { ProgressView().tint(.white) }; Text("Ask a human to review") }
                }
                .buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.coral))
                .disabled(store.hardshipBusy)
                if let error = store.hardshipError { Text(error).font(.caption).foregroundStyle(TimiColor.coral) }
            }
        }.timiCard(TimiColor.coralSoft)
    }
}

struct HardshipPendingView: View {
    var view: HardshipApplicantView

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Eyebrow(text: "STILL CHECKING")
            Text(view.title ?? "Still checking").font(.system(size: 30, weight: .bold, design: .serif))
            Text(view.message ?? "").font(.callout).foregroundStyle(TimiColor.muted)
        }.timiCard(TimiColor.goldSoft)
    }
}

enum HardshipFormat {
    /// `expiresAt`/`grant.expiresAt` arrive as ISO 8601 timestamps; a hardship
    /// screen only ever needs the date.
    static func shortDate(_ iso: String) -> String { String(iso.prefix(10)) }
}
