import Foundation
import TimiVetCore
import SwiftUI
import AppKit

// SwiftUI port of apps/vet-windows/src/TimiVet/Views/MainWindow.xaml, reskinned
// to the clinic owner's HTML mockup (navy sidebar, cream capacity card, blue/
// coral accents, Georgia display type) — see the sidebar nav, live-summary
// bar, and three-choice decision workspace below. The mockup is a *reference*
// for the visual language, not something ported literally: it is a single
// scrolling web page with client-side view-switching, so its "Live intake" /
// "Clinic settings" / "Manage people" nav becomes a `ConsoleSection` switch
// for the first two (drawn in this one window) and the existing separate
// "Manage people" `NSWindow` for the third — a window per distinct task is
// the native idiom the rest of this app already uses (see AppDelegate's
// `showPeopleWindow`), so that split is kept rather than folded into tabs.
public struct ConsoleView: View {
    @Bindable var store: ClinicStore
    var onOpenMini: () -> Void
    var onManagePeople: () -> Void
    var onSignOut: () -> Void
    /// Plays the intake alert on demand. "No sound fires" is not something
    /// anybody should have to wait for a real patient to test.
    var onTestAlert: () -> Void

    @State var callPolicy = "always"
    @State var voicePhone = ""
    @State var quietStart = ""
    @State var quietEnd = ""

    // Facility settings form — seeded once from `store.location` the moment
    // `store.locationLoaded` first flips true (see `.onChange` below), never
    // re-seeded on a later poll so mid-edit typing survives the six-second
    // dashboard refresh. Field set and merge behavior match
    // `apps/vet-web/public/app.js`'s `hydrateSettingsForm`/`wireSettingsPageForm`.
    @State private var facilityKind = "general"
    @State private var facilitySpecies: Set<String> = []
    @State private var facilityCapabilities: Set<String> = []
    @State private var facilityEmergencyCapable = false
    @State private var facilityOtherCapabilities = ""
    @State private var facilityOpen24Hours = false
    @State private var facilityAcceptsWalkIns = true
    @State private var facilityArrivalWindowMinutes = 20
    @State private var facilityBaseExamFeeDollars = ""
    @State private var facilityHoursNote = ""
    @State private var facilityStaffingLevel = "veterinarian"
    @State private var facilityStaffingNote = ""

    // Overflow tools — new widget token draft fields.
    @State private var widgetLabel = ""
    @State private var widgetAllowedSites = ""

    /// Which of the sidebar's in-window destinations is showing.
    private enum ConsoleSection { case operations, settings, overflow }
    @State private var section: ConsoleSection = .operations

    /// The decision workspace's three-way choice — "Available now" / "Custom
    /// availability" / "Cannot receive", mirroring the mockup's choice-grid.
    /// Distinct from `store.responseType` (which is the wire value): this is
    /// only which tile is highlighted and which fields show, and every tile
    /// handler also sets `store.responseType` so the two never disagree.
    private enum DecisionChoice { case now, custom, decline }
    @State private var choice: DecisionChoice = .now

    @State private var showCapacitySheet = false

    public init(store: ClinicStore, onOpenMini: @escaping () -> Void, onManagePeople: @escaping () -> Void, onSignOut: @escaping () -> Void, onTestAlert: @escaping () -> Void = { }) {
        self.store = store
        self.onOpenMini = onOpenMini
        self.onManagePeople = onManagePeople
        self.onSignOut = onSignOut
        self.onTestAlert = onTestAlert
    }

    static let buildStamp: String = {
        guard let url = Bundle.main.executableURL,
              let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate else {
            return "unstamped"
        }
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM HH:mm"
        return formatter.string(from: date)
    }()

    /// `store.userRole` is the raw wire value ("org:admin" / "org:member" —
    /// see `ClinicStore.userRole`, set straight from `session.user?.role`),
    /// which the sidebar previously showed verbatim and uppercased as
    /// "ORG:ADMIN" — a value nobody outside this codebase would recognize.
    static func humanRole(_ role: String) -> String {
        switch role {
        case "org:admin": return "ADMINISTRATOR"
        case "org:member": return "TEAM MEMBER"
        default: return role.uppercased()
        }
    }

    public var body: some View {
        // The console, with the toast layer over it. Overlaid rather than
        // placed in the stack so a confirmation appearing never moves anything
        // underneath it — a queue that shifts down by 40 points at the moment
        // somebody is reaching for a row is worse than no confirmation at all.
        consoleBody.overlay(alignment: .bottomTrailing) { toastLayer }
    }

    private var toastLayer: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(store.toasts) { toast in
                HStack(spacing: 9) {
                    Text(toast.isFailure ? "!" : "✓")
                        .font(TimiVetFont.ui(13, weight: .bold))
                        .foregroundStyle(toast.isFailure ? .white : TimiVetColor.gold)
                    Text(toast.message)
                        .font(TimiVetFont.ui(12, weight: .semibold))
                        .foregroundStyle(.white)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .frame(maxWidth: 420, alignment: .leading)
                .background(toast.isFailure ? TimiVetColor.coralDark : TimiVetColor.navy, in: RoundedRectangle(cornerRadius: 12))
                .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .padding(26)
        .animation(.spring(response: 0.28, dampingFraction: 0.82), value: store.toasts)
        .allowsHitTesting(false)
    }

    private var consoleBody: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: 240)
            VStack(spacing: 0) {
                header
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        switch section {
                        case .operations:
                            liveSummaryBar
                            queueAndWorkspace
                            lowerGrid
                            payoutsSection
                        case .settings:
                            settingsPage
                        case .overflow:
                            overflowToolsPage
                        }
                    }
                    .padding(24)
                }
                footer
            }
            .background(TimiVetColor.canvas)
        }
        .background(TimiVetColor.canvas)
        .task { await store.start() }
        .task {
            await store.loadCallPreferences()
            // Copied into local state once, so typing in the field does not
            // fight the next poll.
            callPolicy = store.callPreferences.callPolicy
            voicePhone = store.callPreferences.voicePhone ?? ""
            quietStart = store.callPreferences.quietHours?.start ?? ""
            quietEnd = store.callPreferences.quietHours?.end ?? ""
        }
        .task { await store.loadPayouts() }
        .task { await store.loadOverflowTools() }
        // Facility settings are bundled into the dashboard response rather
        // than fetched separately (there is no GET /api/clinic/settings) —
        // see `ClinicStore.locationLoaded`. Seeded exactly once so a form
        // in progress is never overwritten by the poll loop.
        .onChange(of: store.locationLoaded) { _, loaded in
            if loaded { seedFacilitySettingsForm() }
        }
        .sheet(isPresented: $showCapacitySheet) { capacitySheet }
    }

    /// Copies `store.location` into the facility-settings form's local
    /// `@State`. Called once, the moment `store.locationLoaded` first flips
    /// true — see the `.onChange` above.
    private func seedFacilitySettingsForm() {
        let location = store.location
        facilityKind = location.kind ?? "general"
        facilitySpecies = Set(location.species ?? [])
        let allCapabilities = Set(location.capabilities ?? [])
        facilityEmergencyCapable = allCapabilities.contains("emergency")
        let known = Set(Self.capabilityOptions.map(\.0))
        facilityCapabilities = allCapabilities.intersection(known)
        facilityOtherCapabilities = allCapabilities.subtracting(known).subtracting(["emergency"]).sorted().joined(separator: ", ")
        facilityOpen24Hours = location.open24Hours ?? false
        facilityAcceptsWalkIns = location.acceptsWalkIns ?? true
        facilityArrivalWindowMinutes = location.arrivalWindowMinutes ?? 20
        // `Math.round(location.baseExamFeeCents / 100)` in
        // apps/vet-web/public/app.js's `hydrateSettingsForm` — rounded, not
        // truncated, so a fee that is not an exact multiple of 100 cents
        // still shows the nearest dollar.
        facilityBaseExamFeeDollars = location.baseExamFeeCents.map { String(Int((Double($0) / 100).rounded())) } ?? ""
        facilityHoursNote = location.hours?.note ?? ""
        facilityStaffingLevel = location.staffingLevel ?? "veterinarian"
        facilityStaffingNote = location.staffingNote ?? ""
    }

    // MARK: Payouts

    /// What the clinic is owed and what it has been paid — a list and a total,
    /// and nothing else.
    ///
    /// Small on purpose. The clinic's own Express dashboard is the place for
    /// bank details, payout schedules and tax documents; duplicating any of
    /// that here would mean two screens that can disagree. This answers the
    /// one question a practice manager actually asks the console: has the
    /// money for last week's arrivals gone out yet.
    ///
    /// The mockup has no equivalent screen for this — it is Tími-owned
    /// financial data this console already surfaces and the reskin does not
    /// remove. It stays on the Live intake page, below the day's arrivals,
    /// since it is operational (today's money) rather than a preference.
    private var payoutsSection: some View {
        DisclosureGroup("Payouts from Tími") {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    moneyCard("TRANSFERRED TO YOU", store.payouts.earnings.transferredCents)
                    moneyCard("PAID OUT BY STRIPE", store.payouts.earnings.paidOutCents)
                    moneyCard("ON ITS WAY", store.payouts.earnings.awaitingPayoutCents)
                }

                // A clinic that cannot receive transfers does not fail loudly
                // anywhere else: deposits are still collected and its share
                // simply accumulates on Tími's side. Saying so here is the
                // only place a practice would ever find out.
                if let connect = store.payouts.connect, !connect.transfersEnabled {
                    Text(connect.disabledReason.map { "Stripe has restricted this clinic's account (\($0)). Nothing can be paid out until that is resolved." }
                        ?? "This clinic's Stripe account is not finished, so Tími cannot pay it yet. Your Tími contact can send the onboarding form again.")
                        .font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                }

                if store.payouts.earnings.transfers.isEmpty && store.payouts.earnings.payouts.isEmpty {
                    Text(store.payoutsLoaded ? "Nothing has been settled yet. A deposit is paid out after the visit is recorded as completed, a no-show, or a late cancellation." : "Loading…")
                        .font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                } else {
                    payoutList("SENT TO YOU BY TÍMI", store.payouts.earnings.transfers)
                    payoutList("PAID TO YOUR BANK BY STRIPE", store.payouts.earnings.payouts)
                }

                Text("Tími's service fee is $50 per completed intake. The standard arrangement collects $25 from the customer at the time of service, with the remainder deducted from this payout — unless your workspace passes the full fee to customers, which is disclosed to them at checkout. The clinic bills the customer directly for veterinary charges; Tími never handles those.")
                    .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
            }
            .padding(.top, 10)
        }
        .timiVetCard()
    }

    private func payoutList(_ title: String, _ entries: [ClinicLedgerEntry]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).timiVetEyebrow()
            if entries.isEmpty {
                Text("None yet.").font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
            } else {
                ForEach(entries) { entry in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(TimiVetMoney.short(entry.occurredAt)).font(TimiVetFont.ui(12, weight: .semibold))
                            // The Stripe id, so a line here can be matched to
                            // a line in the clinic's own Express dashboard.
                            Text(entry.stripeObjectId ?? "—").font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
                        }
                        Spacer()
                        Text(TimiVetMoney.dollars(entry.amountCents)).font(TimiVetFont.ui(13, weight: .semibold))
                        Text(entry.status).font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
                    }
                }
            }
        }
    }

    private func moneyCard(_ title: String, _ cents: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).timiVetEyebrow()
            Text(TimiVetMoney.dollars(cents)).font(TimiVetFont.display(26))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .timiVetCard()
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                // The mockup's `.brand` is set typography, not an image
                // (`.brand-word` + `.brand-live`) — matched here directly
                // rather than through `Image("timinow-wordmark", bundle:
                // .module)`, which depended on a bundled resource actually
                // resolving inside the XcodeGen-generated project and, in
                // practice, was rendering as empty space at the top of the
                // rail with nothing to say why.
                HStack(alignment: .lastTextBaseline, spacing: 9) {
                    Text("Tími").font(TimiVetFont.display(30)).foregroundStyle(.white)
                    Text("NOW · LIVE").font(TimiVetFont.ui(12, weight: .heavy)).foregroundStyle(TimiVetColor.coral)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Tími NOW, live")
                Rectangle().fill(Color.white.opacity(0.12)).frame(height: 1)
                Text("VETERINARY OPERATIONS").font(TimiVetFont.ui(10, weight: .bold)).foregroundStyle(TimiVetColor.railMutedText)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(store.clinicName).font(TimiVetFont.ui(18, weight: .semibold)).foregroundStyle(.white)
                Text(store.clinicAddress).font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.railMutedText)
                if !store.userRole.isEmpty {
                    Text(Self.humanRole(store.userRole)).font(TimiVetFont.ui(9, weight: .bold)).foregroundStyle(TimiVetColor.railTag)
                }
            }
            .padding(.top, 28)
            statusChip.padding(.top, 18)

            VStack(alignment: .leading, spacing: 8) {
                navButton(icon: "tray.full.fill", title: "Live intake", isSelected: section == .operations, badge: store.pending) {
                    section = .operations
                }
                navButton(icon: "gearshape.fill", title: "Clinic settings", isSelected: section == .settings, badge: nil) {
                    section = .settings
                }
                navButton(icon: "arrow.triangle.branch", title: "Overflow tools", isSelected: section == .overflow, badge: nil) {
                    section = .overflow
                }
                // Its own window, not a page: the app already has a dedicated
                // people/roles surface with its own admin gating
                // (PeopleView), and folding it into this window's two pages
                // would mean re-plumbing that gate rather than reusing it.
                navButton(icon: "person.2.fill", title: "Manage people", isSelected: false, badge: nil, action: onManagePeople)
            }
            .padding(.top, 26)

            // These three used TimiVetQuietButtonStyle — solid white pills
            // with an ink border, built for a card on the light canvas. Sat
            // on the navy rail they read as stray light rectangles rather
            // than part of the sidebar. `navButton` (unselected state) is
            // already this rail's own quiet-button language, so these reuse
            // it instead of introducing a second one.
            VStack(alignment: .leading, spacing: 8) {
                navButton(icon: "rectangle.on.rectangle", title: "Open floating console", isSelected: false, badge: nil, action: onOpenMini)
                navButton(icon: "arrow.clockwise", title: "Refresh now", isSelected: false, badge: nil) { Task { await store.refresh(initial: false) } }
                navButton(icon: "rectangle.portrait.and.arrow.right", title: "Sign out", isSelected: false, badge: nil, action: onSignOut)
            }
            .padding(.top, 22)

            Spacer(minLength: 24)
            VStack(alignment: .leading, spacing: 10) {
                Text("Tími routes operational intake. It does not diagnose or replace clinical triage.")
                    .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.railDisclaimer)
                Text("Closing this window keeps alerts running in the menu bar.")
                    .font(TimiVetFont.ui(9)).foregroundStyle(TimiVetColor.railFootnote)
            }
        }
        .padding(22)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(TimiVetColor.navy)
    }

    /// The mockup's `.status-chip` — a dot plus a word, now driven by the
    /// full connection state machine ported from the Windows console rather
    /// than a two-state string: green live, gold demo, coral the moment the
    /// queue on screen might be stale. The panel below the chip carries the
    /// detail and, when unhealthy, a "Reconnect now" action — the operator
    /// saying "the network is back" should never wait out a backoff.
    private var statusChip: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Circle()
                    .fill(chipColor)
                    .frame(width: 9, height: 9)
                Text(store.connectionModeLabel)
                    .font(TimiVetFont.ui(12, weight: .bold))
                    .foregroundStyle(Color.white.opacity(0.92))
                Spacer(minLength: 0)
            }
            if !store.isConnectionHealthy {
                Text(store.connectionDetail)
                    .font(TimiVetFont.ui(10))
                    .foregroundStyle(TimiVetColor.railMutedText)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
                Button("Reconnect now") { Task { await store.reconnectNow() } }
                    .buttonStyle(.plain)
                    .font(TimiVetFont.ui(12, weight: .bold))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .frame(maxWidth: .infinity)
                    .background(TimiVetColor.blue, in: RoundedRectangle(cornerRadius: 9))
                    .padding(.top, 10)
                    .disabled(store.isBusy)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(TimiVetColor.railDeepInk, in: RoundedRectangle(cornerRadius: 10))
    }

    private var chipColor: Color {
        switch store.connectionState {
        case .live: return TimiVetColor.green
        case .demo, .connecting: return TimiVetColor.gold
        case .reconnecting, .offline, .signInRequired: return TimiVetColor.coral
        }
    }

    private func navCountBadge(_ count: Int) -> some View {
        Text("\(count)")
            .font(TimiVetFont.ui(11, weight: .bold))
            .foregroundStyle(TimiVetColor.navy)
            .frame(minWidth: 20)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.white, in: Capsule())
    }

    private func navButton(icon: String, title: String, isSelected: Bool, badge: Int?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon).frame(width: 20)
                Text(title).font(TimiVetFont.ui(13, weight: .bold))
                Spacer(minLength: 8)
                if let badge, badge > 0 { navCountBadge(badge) }
            }
            .padding(.horizontal, 13).padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .foregroundStyle(isSelected ? .white : TimiVetColor.railMutedText)
            .background(isSelected ? TimiVetColor.blue : Color.clear, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }

    // MARK: Header / footer

    private var headerEyebrow: String {
        switch section {
        case .operations: return "IMMEDIATE INTAKE CONTROL"
        case .settings: return "CLINIC CONFIGURATION"
        case .overflow: return "WHEN YOU CAN'T TAKE THEM"
        }
    }
    private var headerTitle: String {
        switch section {
        case .operations: return "Clinic operations"
        case .settings: return "Clinic settings"
        case .overflow: return "Overflow tools"
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(headerEyebrow).timiVetEyebrow()
                Text(headerTitle).font(TimiVetFont.display(31))
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 8) {
                // The mockup's `.sync-dot` — omitted before, which left the
                // header's poll status as text alone with nothing to catch
                // the eye toward a live connection versus a stalled one.
                HStack(spacing: 7) {
                    Circle()
                        .fill(store.isConnectionHealthy ? TimiVetColor.green : TimiVetColor.coral)
                        .frame(width: 7, height: 7)
                    Text(store.statusMessage).font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                }
                if store.isBusy {
                    ProgressView().frame(width: 180)
                }
            }
        }
        .padding(.horizontal, 26)
        .padding(.vertical, 20)
        .background(Color.white)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(TimiVetColor.cardBorder), alignment: .bottom)
    }

    private var footer: some View {
        HStack {
            Text("Independent clinical triage controls all treatment priority.")
                .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
            Spacer()
            // The binary's own write time, for the same reason the iPhone app
            // shows one: "is this the new build" has burned whole debugging
            // rounds, and the executable cannot be wrong about itself.
            Text("Tími NOW · ClearKey Solutions, LLC · built \(Self.buildStamp)").font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 10)
        .background(Color.white)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(TimiVetColor.cardBorder), alignment: .top)
    }

    // MARK: Live summary bar (mockup's `.live-summary`)

    private var statusHeadline: String {
        switch store.availabilityStatus {
        case "available": return "Accepting urgent-care arrivals"
        case "limited": return "Limited availability"
        case "confirm_first": return "Confirm before arrival"
        case "critical_only": return "Critical patients only"
        case "diverting": return "Diverting new arrivals"
        case "closed": return "Temporarily closed"
        default: return store.availabilityStatus.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private var capacitySubtitle: String {
        let spots = "\(store.capacityCount) spot\(store.capacityCount == 1 ? "" : "s")"
        let wait = "\(store.stableWaitMin)–\(store.stableWaitMax) min wait"
        let critical = store.acceptsCritical ? "critical patients accepted" : "stable patients only"
        return "\(spots) · \(wait) · \(critical)"
    }

    private var liveSummaryBar: some View {
        HStack(spacing: 0) {
            summaryMain
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(TimiVetColor.publicCapacityBackground)
            Divider()
            metricTile("WAITING", store.pending, color: TimiVetColor.coral)
            Divider()
            metricTile("ACTIVE ARRIVALS", store.activeArrivals, color: TimiVetColor.ink)
            Divider()
            metricTile("COMPLETED TODAY", store.completedToday, color: TimiVetColor.ink)
            Divider()
            metricTile("DECLINED TODAY", store.declinedToday, color: TimiVetColor.ink)
        }
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: TimiVetMetrics.cardRadius))
        .overlay(RoundedRectangle(cornerRadius: TimiVetMetrics.cardRadius).stroke(TimiVetColor.sectionBorder, lineWidth: 1))
    }

    private var summaryMain: some View {
        HStack(spacing: 14) {
            Image(systemName: "cross.case.fill")
                .foregroundStyle(TimiVetColor.blue)
                .frame(width: 44, height: 44)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(TimiVetColor.sectionBorder, lineWidth: 1))
            VStack(alignment: .leading, spacing: 3) {
                Text(statusHeadline).font(TimiVetFont.ui(15, weight: .bold))
                Text(capacitySubtitle).font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            }
            Spacer(minLength: 10)
            Button("Edit status") { showCapacitySheet = true }
                .buttonStyle(.plain)
                .font(TimiVetFont.ui(13, weight: .bold))
                .foregroundStyle(TimiVetColor.blue)
        }
    }

    private func metricTile(_ title: String, _ value: Int, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(TimiVetFont.ui(10, weight: .bold)).foregroundStyle(TimiVetColor.muted)
            Text("\(value)").font(TimiVetFont.display(24)).foregroundStyle(color)
        }
        .padding(16)
        .frame(minWidth: 118, alignment: .leading)
    }

    /// The mockup's capacity-edit modal, as a native `.sheet`. Edits the same
    /// `store` fields the settings page's "Public intake status" card does —
    /// this is a second entry point onto one piece of state, not a separate
    /// draft, matching how the mockup's modal and settings-page form both
    /// write straight through to the same published status.
    private var capacitySheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("PUBLIC CAPACITY").timiVetEyebrow()
                    Text("Update live status").font(TimiVetFont.display(23))
                }
                Spacer()
                Button { showCapacitySheet = false } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(TimiVetColor.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Intake status").font(TimiVetFont.ui(13, weight: .semibold))
                Picker("", selection: $store.availabilityStatus) {
                    ForEach(ClinicStore.availabilityStatuses, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) }
                }.labelsHidden()
            }
            HStack(spacing: 14) {
                labeledIntField("Min wait", value: $store.stableWaitMin)
                labeledIntField("Max wait", value: $store.stableWaitMax)
                labeledIntField("Capacity", value: $store.capacityCount)
                labeledIntField("Expires (min)", value: $store.ttlMinutes)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Public note").font(TimiVetFont.ui(13, weight: .semibold))
                TextField("Public note", text: $store.publicNote, axis: .vertical)
                    .lineLimit(3, reservesSpace: true)
                    .textFieldStyle(.roundedBorder)
            }
            Toggle("Accepting critical patients", isOn: $store.acceptsCritical).toggleStyle(.checkbox)
            HStack {
                Spacer()
                Button("Cancel") { showCapacitySheet = false }.buttonStyle(TimiVetQuietButtonStyle()).frame(width: 100)
                Button("Publish status") {
                    Task { await store.publish() }
                    showCapacitySheet = false
                }.buttonStyle(TimiVetPrimaryButtonStyle()).frame(width: 170)
            }
        }
        .padding(28)
        .frame(width: 540)
        .background(TimiVetColor.canvas)
    }

    // MARK: Review queue + decision workspace

    private var queueAndWorkspace: some View {
        HStack(alignment: .top, spacing: 18) {
            reviewQueue.frame(maxWidth: .infinity)
            decisionWorkspace.frame(maxWidth: .infinity)
        }
    }

    private var reviewQueue: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("REVIEW QUEUE").timiVetEyebrow()
                    Text("Requests awaiting a decision").font(TimiVetFont.ui(20, weight: .semibold))
                }
                Spacer()
                Text("\(store.pending)").font(TimiVetFont.ui(13, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(TimiVetColor.coral, in: Capsule())
            }
            .padding(18)
            if store.pendingRequests.isEmpty {
                emptyQueueState
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        // Pending, not everything. This heading says "awaiting a
                        // decision" and the list under it was every request the
                        // clinic had — so an answered one stayed put, looking
                        // undecided apart from its buttons, while the count beside
                        // the heading correctly said none were waiting.
                        ForEach(store.pendingRequests) { request in
                            VStack(spacing: 0) {
                                Button { store.select(request) } label: { requestRow(request) }
                                    .buttonStyle(.plain)
                                // Answering is the ordinary case, so it happens
                                // here. Opening the workspace is for shaping an
                                // offer — a later time, a different window, a note.
                                if request.status == "pending" {
                                    HStack(spacing: 8) {
                                        Button("Yes, we can see them") { Task { await store.answer(request, decline: false) } }
                                            .buttonStyle(TimiVetPrimaryButtonStyle(color: TimiVetColor.blue))
                                            .disabled(store.isBusy)
                                        Button("No") { Task { await store.answer(request, decline: true) } }
                                            .buttonStyle(TimiVetQuietButtonStyle())
                                            .disabled(store.isBusy)
                                    }
                                    .padding(.horizontal, 16)
                                    .padding(.bottom, 14)
                                    .background(request.id == store.selectedRequest?.id ? TimiVetColor.blueSoft : Color.clear)
                                }
                            }
                            Divider().foregroundStyle(TimiVetColor.cardBorderAlt)
                        }
                    }
                }
                .frame(minHeight: 400, maxHeight: 520)
            }
        }
        .timiVetCard()
        .padding(0)
    }

    /// The mockup's `.empty-state` — a checkmark and a line, shown only when
    /// the queue is actually clear (not when it just hasn't loaded yet:
    /// `store.pendingRequests` starts empty before the first refresh too, but
    /// that first paint is brief enough this is still the right call).
    private var emptyQueueState: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 22))
                .foregroundStyle(TimiVetColor.green)
                .frame(width: 48, height: 48)
                .background(TimiVetColor.greenSoft, in: Circle())
            Text("Queue is clear").font(TimiVetFont.ui(17, weight: .semibold))
            Text("New intake requests will appear here automatically.")
                .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 46)
    }

    private func requestRow(_ request: ClinicRequest) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(String(request.pet.name.prefix(2)))
                .font(TimiVetFont.ui(13, weight: .bold)).foregroundStyle(.white)
                .frame(width: 38, height: 38)
                .background(TimiVetColor.blue, in: RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 3) {
                Text(request.petLine).font(TimiVetFont.ui(14, weight: .bold))
                Text(request.concernSummary).font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted).lineLimit(2)
                Text(request.requestType).font(TimiVetFont.ui(9, weight: .bold)).foregroundStyle(TimiVetColor.coral)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 5) {
                Text(request.requestedLabel).font(TimiVetFont.ui(10))
                Text(request.travelLabel).font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
                Text(request.status).font(TimiVetFont.ui(10, weight: .bold)).foregroundStyle(TimiVetColor.blue)
            }
        }
        .padding(16)
        .background(request.id == store.selectedRequest?.id ? TimiVetColor.blueSoft : Color.clear)
    }

    @ViewBuilder
    private func ownerSuppliedRow(_ label: String, _ value: String?) -> some View {
        if let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                Text("\(label) — REPORTED BY OWNER, UNVERIFIED").timiVetEyebrow()
                Text(value).font(TimiVetFont.ui(14, weight: .semibold))
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TimiVetColor.goldSoft, in: RoundedRectangle(cornerRadius: 8))
        }
    }

    /// Minutes until `request.requestExpiresAt`, formatted the way the
    /// mockup's "Search expires" field reads. Parsed locally with
    /// `ISO8601DateFormatter` rather than `TimiVetCore`'s internal
    /// `ClinicDateFormat` — that helper is deliberately non-public (it is an
    /// implementation detail of `ClinicRequest`'s own computed labels), so a
    /// different module reaches the same ISO-8601 parsing on its own.
    private func expiresLabel(_ request: ClinicRequest) -> String {
        guard let iso = request.requestExpiresAt, let date = ISO8601DateFormatter().date(from: iso) else { return "—" }
        let minutes = Int(date.timeIntervalSinceNow / 60)
        if minutes <= 0 { return "Expired" }
        return "\(minutes) min"
    }

    private var decisionWorkspace: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("DECISION WORKSPACE").timiVetEyebrow()
                if let request = store.selectedRequest {
                    decisionHeader(request)
                    Divider()
                    decisionBody(request)
                } else {
                    Text("Select a request").font(TimiVetFont.display(27)).foregroundStyle(TimiVetColor.muted)
                }
            }
        }
        .timiVetCard()
        // Keeps the choice-grid and `store.responseType` in lockstep with
        // whichever request is selected. Without this, picking a new request
        // reset the visible tile to "Available now" but left `responseType`
        // holding whatever a previous request's "Custom availability" choice
        // set it to — so a quick accept on the next patient could silently
        // send a stale custom offer. Two-parameter `onChange` is the
        // macOS 14+ form; this package targets exactly that.
        .onChange(of: store.selectedRequest?.id) { _, _ in
            choice = .now
            if let request = store.selectedRequest {
                store.responseType = request.isEmergency ? "emergency_intake" : "available_now"
            }
        }
    }

    private func decisionHeader(_ request: ClinicRequest) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("PATIENT REQUEST").timiVetEyebrow()
                    Text(request.petLine).font(TimiVetFont.display(26))
                    Text(request.requestType).font(TimiVetFont.ui(10, weight: .bold)).foregroundStyle(TimiVetColor.coral)
                }
                Spacer()
                Text(request.travelLabel)
                    .font(TimiVetFont.ui(11, weight: .bold)).foregroundStyle(TimiVetColor.blueDark)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(Color.white, in: Capsule())
                    .overlay(Capsule().stroke(TimiVetColor.blueSoft, lineWidth: 1))
            }
            Text(request.concernSummary).font(TimiVetFont.ui(14))
            ownerSuppliedRow("ALLERGIES", request.pet.allergies)
            ownerSuppliedRow("MEDICATIONS", request.pet.medications)
            HStack(spacing: 22) {
                ownerField("OWNER", request.owner.name)
                // Masked until the owner books with this clinic specifically
                // — `contactRevealed` is false for every search target until
                // then, and always true for a direct intake. Preserved as-is.
                ownerField("PHONE", request.contactRevealed ? (request.owner.phone ?? "No phone on file") : "Hidden until booked")
                ownerField("SEARCH EXPIRES", expiresLabel(request))
            }
        }
    }

    private func decisionBody(_ request: ClinicRequest) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("What can your clinic offer?").font(TimiVetFont.ui(14, weight: .bold))
            HStack(spacing: 10) {
                choiceButton(title: "Available now", subtitle: "Send the standard offer", selected: choice == .now) {
                    choice = .now
                    store.responseType = request.isEmergency ? "emergency_intake" : "available_now"
                }
                choiceButton(title: "Custom availability", subtitle: "Set arrival and wait", selected: choice == .custom) {
                    choice = .custom
                    store.responseType = "available_at"
                }
                choiceButton(title: "Cannot receive", subtitle: "Decline this request", selected: choice == .decline, isDecline: true) {
                    choice = .decline
                }
            }
            if choice == .custom {
                customFields
            }
            HStack(spacing: 12) {
                Button("Reset") {
                    choice = .now
                    store.responseType = request.isEmergency ? "emergency_intake" : "available_now"
                    store.clinicNote = ""
                }.buttonStyle(TimiVetQuietButtonStyle()).frame(width: 100)
                decisionActionButton(request)
            }
        }
    }

    /// One tile of the mockup's `.choice-grid`. `isDecline` only changes the
    /// selected fill color (coral instead of blue), matching
    /// `.choice-button.decline.selected`.
    private func choiceButton(title: String, subtitle: String, selected: Bool, isDecline: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(TimiVetFont.ui(13, weight: .bold))
                Text(subtitle).font(TimiVetFont.ui(11))
                    .foregroundStyle(selected ? Color.white.opacity(0.85) : TimiVetColor.muted)
            }
            .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .foregroundStyle(selected ? Color.white : TimiVetColor.ink)
            .background(selected ? (isDecline ? TimiVetColor.coral : TimiVetColor.blue) : Color.white, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(selected ? Color.clear : TimiVetColor.fieldBorder, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    /// Only shown for "Custom availability" — the mockup's `.custom-fields`,
    /// revealed just for that one choice. "Available now" and "Cannot
    /// receive" send with the clinic's already-published wait window
    /// (`offerWaitMin`/`Max`, kept in sync with the public capacity card) and
    /// the standard 30-minute arrival / 5-minute hold, so the fast path stays
    /// a single click the way the mockup intends.
    private var customFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Available at").font(TimiVetFont.ui(12, weight: .semibold))
                    DatePicker("", selection: $store.availableAt).labelsHidden()
                }
                labeledIntField("Arrival window (min)", value: $store.arrivalWindowMinutes)
                labeledIntField("Offer hold (min)", value: $store.holdMinutes)
            }
            HStack(spacing: 16) {
                labeledIntField("Wait min", value: $store.offerWaitMin)
                labeledIntField("Wait max", value: $store.offerWaitMax)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Message to pet owner").font(TimiVetFont.ui(12, weight: .semibold))
                    + Text(" (optional)").font(TimiVetFont.ui(11)).foregroundColor(TimiVetColor.muted)
                TextField("Add a short arrival instruction or helpful note.", text: $store.clinicNote, axis: .vertical)
                    .lineLimit(4, reservesSpace: true)
                    .textFieldStyle(.roundedBorder)
            }
            Text("An offer does not book the patient. The owner may compare up to five responses. Unselected offers are released automatically.")
                .font(TimiVetFont.ui(11))
                .padding(12)
                .background(TimiVetColor.offerBannerBackground, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder
    private func decisionActionButton(_ request: ClinicRequest) -> some View {
        switch choice {
        case .decline:
            Button("Decline request") { Task { await store.decline() } }
                .buttonStyle(TimiVetCoralButtonStyle()).disabled(store.isBusy)
        case .custom:
            Button("Send custom offer") { Task { await store.offer() } }
                .buttonStyle(TimiVetPrimaryButtonStyle()).disabled(store.isBusy)
        case .now:
            Button(request.searchTarget ? "Send availability offer" : "Accept arrival") { Task { await store.offer() } }
                .buttonStyle(TimiVetPrimaryButtonStyle()).disabled(store.isBusy)
        }
    }

    private func ownerField(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(TimiVetFont.ui(9, weight: .bold)).foregroundStyle(TimiVetColor.muted)
            Text(value).font(TimiVetFont.ui(13, weight: .semibold))
        }
    }

    // MARK: Active arrivals + at-a-glance (mockup's `.lower-grid`)

    /// `store.requests` already carries every status the dashboard returns;
    /// this was previously read only for its count (`store.activeArrivals`).
    /// Filtering it here to actually list who is on the way is new surface
    /// area for data the console already had, matching the mockup's "Active
    /// arrivals" card — no new API call.
    private var activeArrivalsList: [ClinicRequest] {
        store.requests.filter { ["accepted", "en_route", "arrived", "triaged"].contains($0.status) }
    }

    private var lowerGrid: some View {
        HStack(alignment: .top, spacing: 18) {
            activeArrivalsCard.frame(maxWidth: .infinity)
            tipCard.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var activeArrivalsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("ACTIVE ARRIVALS").timiVetEyebrow()
            if activeArrivalsList.isEmpty {
                Text("No active arrivals right now.").font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(activeArrivalsList) { request in
                        HStack(spacing: 12) {
                            Text(String(request.pet.name.prefix(2)))
                                .font(TimiVetFont.ui(12, weight: .bold)).foregroundStyle(.white)
                                .frame(width: 36, height: 36)
                                .background(TimiVetColor.green, in: RoundedRectangle(cornerRadius: 11))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(request.petLine).font(TimiVetFont.ui(13, weight: .bold))
                                Text(request.travelLabel).font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                            }
                            Spacer()
                            Text(request.status.replacingOccurrences(of: "_", with: " ").capitalized)
                                .font(TimiVetFont.ui(11, weight: .bold)).foregroundStyle(TimiVetColor.green)
                                .padding(.horizontal, 9).padding(.vertical, 5)
                                .background(TimiVetColor.greenSoft, in: Capsule())
                        }
                        .padding(.vertical, 10)
                        if request.id != activeArrivalsList.last?.id { Divider() }
                    }
                }
            }
        }
        .timiVetCard()
    }

    private var tipCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("AT A GLANCE").timiVetEyebrow()
            Text("One decision, one send.").font(TimiVetFont.ui(14, weight: .bold))
            Text("Available now sends the clinic's standard offer immediately. Custom availability only appears when a request needs a different arrival window or wait estimate, keeping the routine response fast.")
                .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
        }
        .timiVetCard()
    }

    // MARK: Settings

    private func statusPill(_ text: String, color: Color) -> some View {
        Text(text).font(TimiVetFont.ui(11, weight: .bold)).foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(color.opacity(0.14), in: Capsule())
    }

    private var settingsPage: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top, spacing: 20) {
                VStack(alignment: .leading, spacing: 20) {
                    publicIntakeStatusCard
                    phoneCallsCard
                }.frame(maxWidth: .infinity)
                VStack(alignment: .leading, spacing: 20) {
                    floatingConsoleCard
                    desktopAlertsCard
                }.frame(maxWidth: .infinity)
            }
            // Full-width, not a third column: this card alone carries as many
            // fields as the four above combined, and a narrow column would
            // squeeze the species/capabilities checklists into a scroll well
            // before the rest of the page did.
            facilitySettingsCard
        }
    }

    /// The mockup's cream "Public intake status" card — the settings-page
    /// twin of the live-summary bar's edit sheet, writing through to the
    /// same `store` fields.
    private var publicIntakeStatusCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Public intake status").font(TimiVetFont.ui(17, weight: .semibold))
                    Text("What pet owners see right now.").font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
                }
                Spacer()
                statusPill("Published", color: TimiVetColor.green)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Intake status").font(TimiVetFont.ui(13, weight: .semibold))
                Picker("", selection: $store.availabilityStatus) {
                    ForEach(ClinicStore.availabilityStatuses, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) }
                }.labelsHidden()
            }
            HStack(spacing: 12) {
                labeledIntField("Capacity", value: $store.capacityCount)
                labeledIntField("Min wait", value: $store.stableWaitMin)
                labeledIntField("Max wait", value: $store.stableWaitMax)
                labeledIntField("Expires (min)", value: $store.ttlMinutes)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Public note").font(TimiVetFont.ui(13, weight: .semibold))
                TextField("Public note", text: $store.publicNote, axis: .vertical)
                    .lineLimit(3, reservesSpace: true)
                    .textFieldStyle(.roundedBorder)
            }
            Toggle("Accepting critical patients", isOn: $store.acceptsCritical).toggleStyle(.checkbox)
            Button("Publish live status") { Task { await store.publish() } }
                .buttonStyle(TimiVetPrimaryButtonStyle())
        }
        .timiVetCard(TimiVetColor.publicCapacityBackground)
    }

    /// Calling preferences — admin-gated exactly as before: the Save button
    /// stays disabled and an explanatory line appears for anyone who is not
    /// `store.isAdmin` (the same `org:admin`/`org:member` role the Worker and
    /// `apps/vet-web/public/app.js`'s `isSelfAdmin()` use — see
    /// `ClinicStore.isAdmin`).
    private var phoneCallsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Phone calls from Tími").font(TimiVetFont.ui(17, weight: .semibold))
                Text("Choose when Tími should call the clinic about a new request.").font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            }
            Text("Call this clinic about new requests").font(TimiVetFont.ui(13, weight: .semibold))
            VStack(alignment: .leading, spacing: 6) {
                policyRow("always", "Every request — call even while this console is open")
                policyRow("console_active", "Only while a console is open")
                policyRow("never", "Never — console and notifications only")
            }
            Text("Quiet hours below still silence calls in every mode. Requests always arrive in this console and on the floating panel — the choice is only about ringing the phone.")
                .font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
            VStack(alignment: .leading, spacing: 6) {
                Text("Number to call").font(TimiVetFont.ui(12, weight: .semibold))
                TextField(store.callPreferences.locationPhone ?? "Clinic's listed number", text: $voicePhone)
                    .textFieldStyle(.roundedBorder)
                    .disabled(callPolicy == "never")
                Text("Leave blank to use the clinic's listed number.")
                    .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
            }
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Quiet from").font(TimiVetFont.ui(12, weight: .semibold))
                    TextField("22:00", text: $quietStart).textFieldStyle(.roundedBorder).disabled(callPolicy == "never")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Quiet until").font(TimiVetFont.ui(12, weight: .semibold))
                    TextField("07:00", text: $quietEnd).textFieldStyle(.roundedBorder).disabled(callPolicy == "never")
                }
            }
            Text("24-hour times. Leave both blank for no quiet hours.")
                .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
            Button("Save calling preferences") {
                Task { await store.saveCallPreferences(callPolicy: callPolicy, voicePhone: voicePhone, quietStart: quietStart, quietEnd: quietEnd) }
            }.buttonStyle(TimiVetPrimaryButtonStyle()).disabled(store.isBusy || !store.isAdmin)
            if !store.isAdmin {
                Text("Only a workspace administrator can change these. Ask whoever set up this clinic on Tími.")
                    .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
            }
        }
        .timiVetCard()
    }

    private var floatingConsoleCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Floating console").font(TimiVetFont.ui(17, weight: .semibold))
                Text("Keep requests visible while you work in other apps.").font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            }
            Toggle("Keep above other windows", isOn: $store.settings.miniWindowTopmost).toggleStyle(.checkbox)
            Toggle("Stay above full-screen apps", isOn: $store.settings.stayAboveEverything).toggleStyle(.checkbox)
            Toggle("Open automatically for a new request", isOn: $store.settings.autoShowMiniOnNewRequest).toggleStyle(.checkbox)
            Toggle("Start Tími Vet at login", isOn: $store.settings.startAtLogin).toggleStyle(.checkbox)
            Button("Preview floating console", action: onOpenMini).buttonStyle(TimiVetQuietButtonStyle())
        }
        .timiVetCard()
    }

    private var desktopAlertsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Desktop alerts").font(TimiVetFont.ui(17, weight: .semibold))
                    Text("Visual and sound notifications for this workstation.").font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
                }
                Spacer()
                Toggle("Desktop intake alerts", isOn: $store.settings.alertsEnabled).toggleStyle(.switch).labelsHidden()
            }
            HStack {
                Toggle("Play alert sound", isOn: $store.settings.playSound).toggleStyle(.checkbox)
                Spacer()
                Button("Test", action: onTestAlert).buttonStyle(TimiVetQuietButtonStyle()).frame(width: 80)
            }
            Text("The alert plays through normal output, not the system alert beep — that follows a separate Alert Volume slider, and macOS silences a notification's own sound while this window is frontmost.")
                .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
            VStack(alignment: .leading, spacing: 6) {
                Text("Check for requests every").font(TimiVetFont.ui(12, weight: .semibold))
                Stepper("\(store.settings.pollSeconds) sec", value: $store.settings.pollSeconds, in: 3...60)
            }
            Button("Save alert settings") { Task { await store.saveSettings() } }.buttonStyle(TimiVetPrimaryButtonStyle())
            advancedConnectionSection
        }
        .timiVetCard()
    }

    // Static option lists — value/label pairs, in the same order as the
    // `<option>`/`<input>` elements in apps/vet-web/public/index.html's
    // `data-settings-form` (lines ~410-478), so the picker and checklist
    // order matches the web console exactly.
    private static let facilityKinds: [(value: String, label: String)] = [
        ("general", "General practice"), ("urgent", "Urgent care"),
        ("emergency", "Emergency hospital"), ("specialty", "Specialty clinic")
    ]
    private static let speciesOptions: [(value: String, label: String)] = [
        ("dog", "Dog"), ("cat", "Cat"), ("bird", "Bird"), ("rabbit", "Rabbit"),
        ("reptile", "Reptile"), ("small_mammal", "Small mammal"), ("other", "Other")
    ]
    private static let capabilityOptions: [(value: String, label: String)] = [
        ("surgery", "Surgery"), ("oxygen", "Oxygen support"), ("imaging", "Imaging"),
        ("overnight", "Overnight stay"), ("toxin", "Toxin/poison cases"), ("same_day", "Same-day appointments"),
        ("wellness", "Wellness care"), ("minor_injury", "Minor injury"), ("vaccines", "Vaccines")
    ]
    private static let staffingLevels: [(value: String, label: String)] = [
        ("veterinarian", "A veterinarian"), ("veterinary_technician", "A veterinary technician")
    ]

    /// Two-way binding into a `Set<String>` `@State` for one checkbox — lets
    /// the species/capabilities checklists below bind directly to
    /// `$facilitySpecies`/`$facilityCapabilities` the way a single `Toggle`
    /// binds to a `Bool`.
    private func membershipBinding(_ value: String, in set: Binding<Set<String>>) -> Binding<Bool> {
        Binding(
            get: { set.wrappedValue.contains(value) },
            set: { isOn in if isOn { set.wrappedValue.insert(value) } else { set.wrappedValue.remove(value) } }
        )
    }

    private func checklistGrid(_ options: [(value: String, label: String)], set: Binding<Set<String>>) -> some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 6)], alignment: .leading, spacing: 6) {
            ForEach(options, id: \.value) { option in
                Toggle(option.label, isOn: membershipBinding(option.value, in: set)).toggleStyle(.checkbox)
            }
        }
    }

    /// Stable facility settings — what kind of practice this is, what it
    /// treats, hours, and client-facing defaults. Field set and merge
    /// behavior match `apps/vet-web/public/index.html`'s
    /// `data-settings-form` and `apps/vet-web/public/app.js`'s
    /// `hydrateSettingsForm`/`wireSettingsPageForm` exactly — see
    /// `ClinicStore.saveLocationSettings` for how the checkbox list, the
    /// "accepts emergency" checkbox, and the free-text field are folded into
    /// one `capabilities` array before the Worker ever sees them.
    private var facilitySettingsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Facility settings").font(TimiVetFont.ui(17, weight: .semibold))
                Text("What pet owners see about your practice by default, and what a request is matched against. This changes rarely.")
                    .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            }

            HStack(alignment: .top, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Facility type").font(TimiVetFont.ui(13, weight: .semibold))
                    Picker("", selection: $facilityKind) {
                        ForEach(Self.facilityKinds, id: \.value) { Text($0.label).tag($0.value) }
                    }.labelsHidden()
                }
                Toggle("Accepts emergency-level patients", isOn: $facilityEmergencyCapable)
                    .toggleStyle(.checkbox)
                    .padding(.top, 22)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Species accepted").font(TimiVetFont.ui(13, weight: .semibold))
                checklistGrid(Self.speciesOptions, set: $facilitySpecies)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Capabilities").font(TimiVetFont.ui(13, weight: .semibold))
                checklistGrid(Self.capabilityOptions, set: $facilityCapabilities)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Other capabilities (comma separated)").font(TimiVetFont.ui(12))
                    TextField("dental, exotics, cardiology", text: $facilityOtherCapabilities).textFieldStyle(.roundedBorder)
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 20) {
                    Toggle("Open 24 hours", isOn: $facilityOpen24Hours).toggleStyle(.checkbox)
                    Toggle("Accepts walk-ins", isOn: $facilityAcceptsWalkIns).toggleStyle(.checkbox)
                }
                HStack(spacing: 16) {
                    labeledIntField("Typical arrival window (min)", value: $facilityArrivalWindowMinutes)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Base exam fee (USD)").font(TimiVetFont.ui(12))
                        TextField("185", text: $facilityBaseExamFeeDollars).textFieldStyle(.roundedBorder).frame(width: 110)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Hours & operating notes, shown to pet owners").font(TimiVetFont.ui(13, weight: .semibold))
                    TextField("Mon–Fri 8am–8pm, Sat 9am–4pm. Closed major holidays.", text: $facilityHoursNote, axis: .vertical)
                        .lineLimit(3, reservesSpace: true)
                        .textFieldStyle(.roundedBorder)
                }
            }

            HStack(alignment: .top, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Staffed by").font(TimiVetFont.ui(13, weight: .semibold))
                    Picker("", selection: $facilityStaffingLevel) {
                        ForEach(Self.staffingLevels, id: \.value) { Text($0.label).tag($0.value) }
                    }.labelsHidden()
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Staffing note (optional)").font(TimiVetFont.ui(12))
                    TextField("", text: $facilityStaffingNote).textFieldStyle(.roundedBorder)
                }.frame(maxWidth: .infinity)
            }

            Button("Save facility settings") {
                Task {
                    await store.saveLocationSettings(
                        kind: facilityKind, species: facilitySpecies, capabilities: facilityCapabilities,
                        emergencyCapable: facilityEmergencyCapable, otherCapabilities: facilityOtherCapabilities,
                        open24Hours: facilityOpen24Hours, acceptsWalkIns: facilityAcceptsWalkIns,
                        arrivalWindowMinutes: facilityArrivalWindowMinutes, baseExamFeeDollars: facilityBaseExamFeeDollars,
                        hoursNote: facilityHoursNote, staffingLevel: facilityStaffingLevel, staffingNote: facilityStaffingNote
                    )
                }
            }.buttonStyle(TimiVetPrimaryButtonStyle()).disabled(store.isBusy)
        }
        .timiVetCard()
    }

    /// The mockup's collapsible "Advanced connection settings" — gated to
    /// `store.isAdmin` (see `phoneCallsCard`'s doc comment for the role
    /// vocabulary). This gate is new: the fields existed before with no
    /// admin check at all. A non-admin now sees a one-line explanation
    /// instead of the Worker URL / tenant ID fields, rather than being able
    /// to edit them and hit whatever happens when a non-admin's console
    /// points itself at a different Worker.
    ///
    /// Both this section's "Save and reconnect" and the card above's "Save
    /// alert settings" call the same `store.saveSettings()` — `AppSettings`
    /// is persisted and reconnected as one unit, so there is no partial-save
    /// path to add a second method for; the two buttons are two entry points
    /// onto one action, matching how "Publish live status" and the capacity
    /// sheet's "Publish status" both call `store.publish()`.
    private var advancedConnectionSection: some View {
        Group {
            if store.isAdmin {
                DisclosureGroup("Advanced connection settings") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Cloudflare Worker HTTPS URL").font(TimiVetFont.ui(13, weight: .semibold))
                        TextField("https://your-clinic.example.workers.dev", text: $store.settings.apiBaseUrl).textFieldStyle(.roundedBorder)
                        Text("Tenant ID (loopback demo header)").font(TimiVetFont.ui(13, weight: .semibold))
                        TextField("tenant_hearth", text: $store.settings.tenantId).textFieldStyle(.roundedBorder)
                        Text("Sign in above establishes the real Clerk session; this field only matters against a loopback dev Worker with no session.")
                            .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
                        Button("Save and reconnect") { Task { await store.saveSettings() } }.buttonStyle(TimiVetPrimaryButtonStyle())
                    }
                    .padding(.top, 8)
                }
                .padding(.top, 6)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("ADVANCED CONNECTION SETTINGS").timiVetEyebrow()
                    Text("Only a workspace administrator can view or change the Worker connection. Ask whoever set up this clinic on Tími.")
                        .font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                }
                .padding(.top, 6)
            }
        }
    }

    /// One radio-style row of the call-policy group. A custom row rather than
    /// a stock Picker so it takes the same rounded-10, Tími-blue look as the
    /// fields around it.
    private func policyRow(_ value: String, _ title: String) -> some View {
        let selected = callPolicy == value
        return Button {
            callPolicy = value
        } label: {
            HStack(alignment: .center, spacing: 9) {
                ZStack {
                    Circle()
                        .stroke(selected ? TimiVetColor.blue : TimiVetColor.fieldBorder, lineWidth: 1.5)
                        .frame(width: 14, height: 14)
                    if selected {
                        Circle().fill(TimiVetColor.blue).frame(width: 8, height: 8)
                    }
                }
                Text(title)
                    .font(TimiVetFont.ui(12, weight: selected ? .semibold : .regular))
                    .foregroundStyle(TimiVetColor.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(selected ? TimiVetColor.blueSoft : Color.white, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? TimiVetColor.blue : TimiVetColor.fieldBorder, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    private func labeledIntField(_ title: String, value: Binding<Int>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(TimiVetFont.ui(12))
            TextField(title, value: value, format: .number).textFieldStyle(.roundedBorder).frame(width: 110)
        }
    }

    // MARK: Overflow tools
    //
    // Mirrors apps/vet-web/public/app.js's enterOverflow()/renderOverflow():
    // the tenant's stable referral link (src/referrals.js) and its website
    // status widget tokens (src/widget.js), both loaded once via
    // `store.loadOverflowTools()` — see the `.task` on `consoleBody`.

    private var overflowToolsPage: some View {
        VStack(alignment: .leading, spacing: 20) {
            referralLinkCard
            widgetTokensCard
        }
    }

    /// `store.referralLink?.slug` turned into the URL a pet owner actually
    /// taps — matches `apps/vet-web/public/app.js`'s `referralUrl()`
    /// (`customerAppOrigin() + "/r/" + encodeURIComponent(slug)`).
    private var referralURL: String {
        guard let slug = store.referralLink?.slug, !slug.isEmpty else { return "" }
        let encodedSlug = slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? slug
        return "\(TimiVetEnvironment.defaultCustomerAppURL)/r/\(encodedSlug)"
    }

    private var referralLinkCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Stable referral link").font(TimiVetFont.ui(17, weight: .semibold))
                Text("Send owners to Tími when you can't take them — this always leads into Tími's own nearby-clinic search, never a named competitor.")
                    .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            }
            if !store.overflowToolsLoaded {
                Text("Loading…").font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            } else if referralURL.isEmpty {
                Text("Could not load your referral link.").font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Your link").font(TimiVetFont.ui(12, weight: .semibold))
                    TextField("", text: .constant(referralURL)).textFieldStyle(.roundedBorder).disabled(true)
                }
                HStack(spacing: 14) {
                    Button("Copy link") { copyToClipboard(referralURL, label: "Referral link") }
                        .buttonStyle(TimiVetQuietButtonStyle())
                    let clicks = store.referralLink?.clickCount ?? 0
                    Text("Clicked \(clicks) time\(clicks == 1 ? "" : "s").")
                        .font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                }
            }
        }
        .timiVetCard()
    }

    /// Admin-gated exactly like `phoneCallsCard`: token creation and
    /// revocation both require `isOrgAdmin` server-side
    /// (`handleCreateWidgetToken`/`handleRevokeWidgetToken` in
    /// `src/widget.js`), so a non-admin sees the list read-only rather than
    /// controls that would only fail on submit.
    private var widgetTokensCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Website status widget").font(TimiVetFont.ui(17, weight: .semibold))
                Text("A small card pet owners see on your own website: whether you're currently accepting urgent patients, and — if not — a link into Tími. It never shows your name, address, exact capacity, or any customer data.")
                    .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            }

            if store.isAdmin {
                VStack(alignment: .leading, spacing: 8) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Label (optional)").font(TimiVetFont.ui(12))
                        TextField("Front page badge", text: $widgetLabel).textFieldStyle(.roundedBorder)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Allowed sites (optional, one per line)").font(TimiVetFont.ui(12))
                        TextField("https://www.yourclinic.example", text: $widgetAllowedSites, axis: .vertical)
                            .lineLimit(2, reservesSpace: true)
                            .textFieldStyle(.roundedBorder)
                    }
                    Button("Create widget token") {
                        let origins = widgetAllowedSites.split(separator: "\n")
                            .map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }
                        Task {
                            await store.createWidgetToken(label: widgetLabel, allowedOrigins: origins)
                            widgetLabel = ""
                            widgetAllowedSites = ""
                        }
                    }.buttonStyle(TimiVetPrimaryButtonStyle()).disabled(store.isBusy)
                }
            }

            if let secret = store.newWidgetTokenSecret {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Save this now — it won't be shown again.").font(TimiVetFont.ui(12, weight: .bold))
                    Text(secret).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                    HStack(spacing: 10) {
                        Button("Copy token") { copyToClipboard(secret, label: "Widget token") }.buttonStyle(TimiVetQuietButtonStyle())
                        Button("I've saved it") { store.newWidgetTokenSecret = nil }.buttonStyle(TimiVetQuietButtonStyle())
                    }
                }
                .padding(10)
                .background(TimiVetColor.goldSoft, in: RoundedRectangle(cornerRadius: 8))
            }

            if store.widgetTokens.isEmpty {
                Text(store.overflowToolsLoaded ? "No widget tokens yet." : "Loading…")
                    .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            } else {
                VStack(spacing: 0) {
                    ForEach(store.widgetTokens) { token in
                        widgetTokenRow(token)
                        if token.id != store.widgetTokens.last?.id { Divider() }
                    }
                }
            }

            if !store.isAdmin {
                Text("Only a workspace administrator can create or revoke widget tokens.")
                    .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
            }
        }
        .timiVetCard()
    }

    private func widgetTokenRow(_ token: WidgetToken) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(token.label ?? "—").font(TimiVetFont.ui(13, weight: .semibold))
                Text("\(token.prefix)…").font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                Text(token.allowedOrigins.isEmpty ? "Any site" : token.allowedOrigins.joined(separator: ", "))
                    .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(token.status == "revoked" ? "Revoked" : (token.lastUsedAt != nil ? "Used" : "Never used"))
                    .font(TimiVetFont.ui(10, weight: .bold))
                    .foregroundStyle(token.status == "revoked" ? TimiVetColor.muted : TimiVetColor.green)
                if token.status == "active" && store.isAdmin {
                    Button("Revoke") { Task { await store.revokeWidgetToken(token) } }
                        .buttonStyle(.plain)
                        .font(TimiVetFont.ui(11, weight: .bold))
                        .foregroundStyle(TimiVetColor.coral)
                }
            }
        }
        .padding(.vertical, 10)
    }

    /// `NSPasteboard` lives here (`TimiVetUI`, which already imports
    /// `AppKit` for `AlertCenter`/`FloatingPanel`) rather than on
    /// `ClinicStore` in the plain-Foundation `TimiVetCore` module —
    /// `ClinicStore.noteCopied` only raises the confirmation toast.
    private func copyToClipboard(_ text: String, label: String) {
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        store.noteCopied(label)
    }
}
