import Foundation
import Observation
#if canImport(Network)
import Network
#endif

/// The connection lifecycle, ported from the Windows console's
/// `ConsoleConnectionState`: a console that silently stops updating is worse
/// than one that is plainly down — the queue looks empty because it is
/// stale, and nobody can tell the difference from across the room.
public enum ConsoleConnectionState: String, Sendable {
    case connecting, live, demo, reconnecting, offline, signInRequired
}

// Swift port of apps/vet-windows/src/TimiVet/ViewModels/MainViewModel.cs.
// `@MainActor @Observable` plays the same role Skip's SwiftUI bridge expects
// as apps/customer-mobile/Sources/TimiNowCore/AppStore.swift.
@MainActor @Observable public final class ClinicStore {
    public var settings: AppSettings
    public var selectedRequest: ClinicRequest?
    public var isBusy = false
    public var statusMessage = "Connecting to Tími…"

    /// Short-lived confirmations, newest first.
    ///
    /// Every action wrote its outcome into `statusMessage`, which is a line of
    /// small grey text in the connection panel — and that panel is also where
    /// the poll writes "Updated 8:20:33 PM · next check in 15 sec" every
    /// fifteen seconds. So the confirmation for a button at the bottom of the
    /// window appeared at the top of it, in the same grey as the countdown,
    /// and was overwritten by the next poll within seconds. Nothing about that
    /// tells a receptionist their offer was sent.
    public var toasts: [ClinicToast] = []

    /// Reports an outcome where the operator is looking.
    ///
    /// `statusMessage` is kept as well: it is what the connection panel shows
    /// and what VoiceOver reads. The toast is what a receptionist sees.
    func succeed(_ message: String) { statusMessage = message; show(ClinicToast(message: message, isFailure: false), seconds: 3) }

    /// Failures linger. "Sent" needs a glance; "could not send" needs reading.
    func fail(_ message: String) { statusMessage = message; show(ClinicToast(message: message, isFailure: true), seconds: 7) }

    /// A small confirmation for a clipboard copy. `succeed`/`fail` above are
    /// `internal` (this module only) on purpose, so the overflow-tools page
    /// in `TimiVetUI` — where the actual `NSPasteboard` call lives, this
    /// module stays plain Foundation — reaches the same toast through this
    /// one `public` entry point instead of widening either.
    public func noteCopied(_ label: String) { succeed("\(label) copied to clipboard.") }

    private func show(_ toast: ClinicToast, seconds: Double) {
        // Three is the most that can be read before the first one goes. Past
        // that they stop being confirmations and become a log.
        toasts.insert(toast, at: 0)
        if toasts.count > 3 { toasts.removeLast(toasts.count - 3) }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            self?.toasts.removeAll { $0.id == toast.id }
        }
    }
    public var clinicName = "Tími veterinary console"
    public var clinicAddress = ""
    public var tenantName = ""
    public var userRole = ""
    public var connectionMode = "CONNECTING"

    // MARK: - Connection state machine (ported from the Windows console)

    public var connectionState: ConsoleConnectionState = .connecting
    /// The full sentence for the CURRENT MODE panel: what happened, when the
    /// last good update was, and when the next attempt is.
    public var connectionDetail = "Reaching the Tími Worker…"
    /// Demo counts as healthy; it is working as asked.
    public var isConnectionHealthy: Bool { connectionState == .live || connectionState == .demo }

    /// The rail chip's wording — matches the Windows `ConnectionModeLabel`.
    public var connectionModeLabel: String {
        switch connectionState {
        case .live: return "Live connection"
        case .demo: return "Interactive demo"
        case .reconnecting: return "Reconnecting…"
        case .offline: return "Offline — queue is stale"
        case .signInRequired: return "Sign-in required"
        case .connecting: return "Connecting…"
        }
    }

    private var consecutiveFailures = 0
    private var lastSuccessfulRefresh: Date?
    /// Widening backoff once the Worker stops answering: hammering an
    /// unreachable Worker every six seconds does not bring it back any
    /// sooner and does fill a clinic's connection with retries.
    private static let backoffSeconds = [5, 10, 20, 40, 60]

    public var nextDelaySeconds: Int {
        consecutiveFailures == 0
            ? clampedPollSeconds
            : Self.backoffSeconds[min(consecutiveFailures - 1, Self.backoffSeconds.count - 1)]
    }

    private func markConnected() {
        consecutiveFailures = 0
        lastSuccessfulRefresh = Date()
        connectionState = api.isDemo ? .demo : .live
        connectionMode = api.isDemo ? "INTERACTIVE DEMO" : "LIVE CLOUDFLARE CONNECTION"
        connectionDetail = "Updated \(Self.timeFormatter.string(from: Date())) · next check in \(nextDelaySeconds) sec"
        statusMessage = connectionDetail
    }

    /// Being refused is not the same as not being answered, and the two need
    /// different words: a 401 that survived the token retry means this
    /// credential is finished and somebody has to sign in, while a timeout
    /// means wait. Guessing wrong in either direction is expensive — one
    /// strands a clinic on a stale queue, the other throws away a working
    /// session over a dropped packet.
    private func markDisconnected(reason: String, authenticationFailure: Bool) {
        consecutiveFailures += 1
        if authenticationFailure {
            connectionState = .signInRequired
            connectionMode = "SIGN-IN REQUIRED"
            connectionDetail = "Tími would not accept this session — \(reason) Sign out and back in to continue."
        } else {
            connectionState = consecutiveFailures >= 3 ? .offline : .reconnecting
            connectionMode = connectionState == .offline ? "OFFLINE — QUEUE IS STALE" : "RECONNECTING"
            let since = lastSuccessfulRefresh.map { " Last update \(Self.timeFormatter.string(from: $0))." } ?? ""
            connectionDetail = "\(reason) Trying again in \(nextDelaySeconds) sec (attempt \(consecutiveFailures)).\(since)"
        }
        statusMessage = "Connection issue · \(reason)"
    }

    /// Cuts the current wait short so the next attempt happens now — used by
    /// the network monitor when connectivity returns, and by Reconnect now.
    private func wakePoll() {
        sleepTask?.cancel()
    }

    /// The rail's "Reconnect now" button: the operator saying "the network is
    /// back, try again" should never have to wait out a sixty-second backoff.
    public func reconnectNow() async {
        consecutiveFailures = 0
        wakePoll()
        await refresh(initial: true)
    }
    public var pending = 0
    public var activeArrivals = 0
    public var completedToday = 0
    public var declinedToday = 0

    public var requests: [ClinicRequest] = []
    public var pendingRequests: [ClinicRequest] = []

    /// The dashboard's own `location`, carrying the facility-settings fields
    /// (`species`, `capabilities`, `hours`, …) alongside the display fields
    /// the rest of the console already used. Set on every `refresh()`, same
    /// as `pending`/`activeArrivals`/etc.
    public var location = ClinicLocationSummary()
    /// True from the first successful `refresh()` onward. `ConsoleView` seeds
    /// its facility-settings form fields the one time this flips to `true` —
    /// never on a later poll, so mid-edit typing in that form is never
    /// clobbered by the six-second refresh loop the way a form bound
    /// straight to `location` would be.
    public var locationLoaded = false

    public static let availabilityStatuses = ["available", "limited", "confirm_first", "critical_only", "diverting", "closed"]
    public static let responseTypes = ["available_now", "available_at", "emergency_intake"]

    // Public Capacity form (POST /api/clinic/availability).
    public var availabilityStatus = "available"
    public var stableWaitMin = 15
    public var stableWaitMax = 35
    public var capacityCount = 3
    public var ttlMinutes = 30
    public var acceptsCritical = true
    public var publicNote = "Accepting stable urgent-care arrivals."

    // Decision Workspace form (POST .../decision).
    public var responseType = "available_now"
    public var availableAt = Date().addingTimeInterval(30 * 60)
    public var arrivalWindowMinutes = 30
    public var holdMinutes = 5
    public var offerWaitMin = 15
    public var offerWaitMax = 35
    public var clinicNote = ""

    public var isAdmin: Bool {
        let role = userRole.lowercased()
        return role.hasSuffix(":admin") || role == "admin"
    }

    /// Set by TimiVetApp/AlertCenter to raise a desktop notification; fired
    /// only for requests that arrived after the console was already running
    /// — the same "don't alert on first load" guard as the Windows client.
    ///
    /// Not optional, and deliberately so: Skip's bridge generator emits a
    /// non-optional `@Sendable` closure for a bridged callback property, so
    /// an optional here produces generated Swift that does not compile. A
    /// no-op default carries the same "nobody is listening yet" meaning.
    public var onNewRequest: (ClinicRequest) -> Void = { _ in }

    private let settingsStore: SettingsStore
    private let api: ClinicAPIClient
    private var knownPending: Set<String> = []
    private var initialized = false
    private var pollTask: Task<Void, Never>?
    /// The poll loop's current sleep, cancellable so `wakePoll()` can cut a
    /// backoff short — the Swift spelling of the Windows `_sleepCancellation`.
    private var sleepTask: Task<Void, Never>?
    #if canImport(Network)
    /// The network coming back is a fact the OS already knows, and waiting
    /// out a sixty-second backoff after it does is a minute of a queue
    /// nobody is watching — same reasoning as the Windows client's
    /// NetworkChange handlers.
    private var pathMonitor: NWPathMonitor?
    #endif

    public init(settingsStore: SettingsStore, settings: AppSettings, api: ClinicAPIClient) {
        self.settingsStore = settingsStore
        self.settings = settings
        self.api = api
    }

    /// Applies `GET /api/session` so the left rail shows the real workspace,
    /// not the dashboard's echo — same intent as the Windows `ApplySession`.
    public func applySession(_ session: SessionDescriptor) {
        tenantName = session.tenant?.name ?? ""
        clinicName = session.location?.name ?? session.tenant?.name ?? "Tími veterinary console"
        clinicAddress = session.location?.address ?? ""
        userRole = session.user?.role ?? ""
    }

    public func select(_ request: ClinicRequest?) {
        selectedRequest = request
        if let request, request.isEmergency { responseType = "emergency_intake" }
    }

    public func start() async {
        await refresh(initial: true)
        pollTask?.cancel()
        pollTask = Task { [weak self] in await self?.pollLoop() }
        #if canImport(Network)
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor [weak self] in self?.wakePoll() }
        }
        monitor.start(queue: DispatchQueue(label: "timi.vet.network-monitor"))
        pathMonitor = monitor
        #endif
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
        sleepTask?.cancel()
        sleepTask = nil
        #if canImport(Network)
        pathMonitor?.cancel()
        pathMonitor = nil
        #endif
    }

    public var clampedPollSeconds: Int { min(60, max(3, settings.pollSeconds)) }

    public func refresh(initial: Bool) async {
        if isBusy && !initial { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let dashboard = try await api.getDashboard()
            pending = dashboard.metrics.pending
            activeArrivals = dashboard.metrics.activeArrivals
            completedToday = dashboard.metrics.completedToday
            declinedToday = dashboard.metrics.declinedToday
            applyAvailability(dashboard.location.availability)
            location = dashboard.location
            if !locationLoaded { locationLoaded = true }

            let selectedId = selectedRequest?.id
            var nextRequests: [ClinicRequest] = []
            var nextPending: [ClinicRequest] = []
            for request in dashboard.requests {
                nextRequests.append(request)
                guard request.status == "pending" else { continue }
                nextPending.append(request)
                if initialized {
                    if !knownPending.contains(request.id) {
                        knownPending.insert(request.id)
                        onNewRequest(request)
                    }
                } else {
                    knownPending.insert(request.id)
                }
            }
            requests = nextRequests
            pendingRequests = nextPending
            // From the pending list, which is what the queue shows.
            selectedRequest = pendingRequests.first(where: { $0.id == selectedId }) ?? pendingRequests.first
            initialized = true
            markConnected()
        } catch ClinicAPIError.signInRequired {
            markDisconnected(reason: ClinicAPIError.signInRequired.message, authenticationFailure: true)
        } catch let error as ClinicAPIError {
            markDisconnected(reason: error.message, authenticationFailure: false)
        } catch is CancellationError {
            // Shutting down; not a connection verdict.
        } catch {
            markDisconnected(reason: error.localizedDescription, authenticationFailure: false)
        }
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            // A cancellable child rather than a bare Task.sleep, so
            // `wakePoll()` (network back, Reconnect now) cuts a widening
            // backoff short instead of waiting it out.
            let delay = nextDelaySeconds
            // `_ =` keeps the closure's type Void: newer Swift infers the bare
            // `try? await` expression as `()?`, making this Task<()?, Never>.
            let sleep = Task { _ = try? await Task.sleep(for: .seconds(delay)) }
            sleepTask = sleep
            await sleep.value
            sleepTask = nil
            if Task.isCancelled { break }
            await refresh(initial: false)
        }
    }

    public func publish() async {
        if stableWaitMin > stableWaitMax { fail("Minimum wait cannot exceed maximum wait."); return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await api.publishAvailability(AvailabilityUpdate(
                intakeStatus: availabilityStatus, stableWaitMin: stableWaitMin, stableWaitMax: stableWaitMax,
                capacityCount: capacityCount, ttlMinutes: ttlMinutes, acceptsCritical: acceptsCritical, note: publicNote
            ))
            succeed("Live intake status published.")
            await refresh(initial: true)
        } catch let error as ClinicAPIError { fail(error.message) }
        catch { fail(error.localizedDescription) }
    }

    public func offer() async { await respond(decline: false) }
    public func decline() async { await respond(decline: true) }

    /// Answer one request without opening the workspace first.
    ///
    /// Every response used to go through the decision workspace: select the
    /// row, read four number fields, press a button. That is the right screen
    /// for shaping an offer and the wrong one for the ordinary case, which is
    /// "yes, usual window" or "no, we're full" — and it is the only thing the
    /// floating panel could offer at all, which is why a queue alert led to
    /// "Open decision workspace" rather than to an answer.
    ///
    /// The workspace's current values are used as they stand, which is what
    /// makes this one press: they are the clinic's own defaults until somebody
    /// changes them.
    public func answer(_ request: ClinicRequest, decline: Bool) async {
        selectedRequest = request
        await respond(decline: decline)
    }

    private func respond(decline: Bool) async {
        guard let request = selectedRequest else { return }
        if !decline && offerWaitMin > offerWaitMax { fail("Offer minimum wait cannot exceed maximum wait."); return }
        isBusy = true
        defer { isBusy = false }
        do {
            let availableAtISO = responseType == "available_at" ? ISO8601DateFormatter().string(from: availableAt) : nil
            let decision = DecisionPayload(
                decision: decline ? "decline" : "offer", responseType: responseType, availableAt: availableAtISO,
                arrivalWindowMinutes: arrivalWindowMinutes, holdMinutes: holdMinutes, waitMin: offerWaitMin, waitMax: offerWaitMax, note: clinicNote
            )
            try await api.respond(to: request, decision: decision)
            // The beacon carries the shape of the decision and nothing that
            // names the clinic, the pet, or the request — /api/analytics is
            // cookieless by contract.
            api.trackEvent("decision_made", meta: ["decision": decline ? "decline" : "offer"])
            succeed(decline
                ? "Declined \(request.pet.name)'s request."
                : (request.searchTarget ? "Availability offer sent for \(request.pet.name)." : "Arrival accepted for \(request.pet.name)."))
            selectedRequest = nil
            clinicNote = ""
            await refresh(initial: true)
        } catch let error as ClinicAPIError { fail(error.message) }
        catch { fail(error.localizedDescription) }
    }

    // MARK: - Calling preferences

    public var callPreferences = CallPreferences()
    public var callPreferencesLoaded = false

    public func loadCallPreferences() async {
        do {
            callPreferences = try await api.getCallPreferences()
            callPreferencesLoaded = true
        } catch let error as ClinicAPIError { fail(error.message) }
        catch { fail(error.localizedDescription) }
    }

    /// `callPolicy` is "always", "console_active", or "never" — a plain String
    /// on purpose (validated server-side), so the Core surface stays simple.
    public func saveCallPreferences(callPolicy: String, voicePhone: String, quietStart: String, quietEnd: String) async {
        isBusy = true
        defer { isBusy = false }
        let trimmedPhone = voicePhone.trimmingCharacters(in: .whitespaces)
        let start = quietStart.trimmingCharacters(in: .whitespaces)
        let end = quietEnd.trimmingCharacters(in: .whitespaces)
        // Both or neither: half a quiet-hours window is not a window, and the
        // Worker refuses it rather than storing something it will ignore at
        // three in the morning.
        let quiet = (start.isEmpty && end.isEmpty) ? QuietHours(start: "", end: "") : QuietHours(start: start, end: end)
        do {
            callPreferences = try await api.updateCallPreferences(
                CallPreferencesUpdate(callPolicy: callPolicy, voicePhone: trimmedPhone, quietHours: quiet)
            )
            let message: String
            switch callPolicy {
            case "never": message = "Tími will not call this clinic. Requests still arrive in the console."
            case "console_active": message = "Tími will call only while a Tími console is open."
            default: message = "Tími will call this clinic about new requests."
            }
            succeed(message)
        } catch let error as ClinicAPIError { fail(error.message) }
        catch { fail(error.localizedDescription) }
    }

    // MARK: - Facility settings

    /// Mirrors `apps/vet-web/public/app.js`'s `wireSettingsPageForm`: the
    /// checkbox capability list, the "accepts emergency" checkbox, and the
    /// free-text "other capabilities" field are all folded into one
    /// `capabilities` array before the Worker ever sees them — there is no
    /// separate `emergencyCapable` field on the wire, only `"emergency"`
    /// joining (or leaving) the same array the checkboxes populate.
    public func saveLocationSettings(
        kind: String, species: Set<String>, capabilities: Set<String>, emergencyCapable: Bool, otherCapabilities: String,
        open24Hours: Bool, acceptsWalkIns: Bool, arrivalWindowMinutes: Int, baseExamFeeDollars: String,
        hoursNote: String, staffingLevel: String, staffingNote: String
    ) async {
        if species.isEmpty { fail("Choose at least one species this location treats."); return }
        isBusy = true
        defer { isBusy = false }
        var mergedCapabilities = capabilities
        if emergencyCapable { mergedCapabilities.insert("emergency") } else { mergedCapabilities.remove("emergency") }
        otherCapabilities.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
            .forEach { mergedCapabilities.insert($0) }
        // Dollars in the form, cents on the wire — left absent (rather than
        // 0) when the field is blank, so the Worker keeps whatever fee this
        // location already had instead of zeroing it out.
        let trimmedFee = baseExamFeeDollars.trimmingCharacters(in: .whitespaces)
        let baseExamFeeCents: Int? = trimmedFee.isEmpty ? nil : Double(trimmedFee).map { Int(($0 * 100).rounded()) }
        do {
            location = try await api.updateClinicSettings(ClinicSettingsUpdate(
                kind: kind, species: Array(species), capabilities: Array(mergedCapabilities),
                open24Hours: open24Hours, acceptsWalkIns: acceptsWalkIns, arrivalWindowMinutes: arrivalWindowMinutes,
                baseExamFeeCents: baseExamFeeCents, hoursNote: hoursNote, staffingLevel: staffingLevel, staffingNote: staffingNote
            ))
            succeed("Facility settings saved.")
        } catch let error as ClinicAPIError { fail(error.message) }
        catch { fail(error.localizedDescription) }
    }

    // MARK: - Overflow tools (referral link + website status widget tokens)

    public var referralLink: ReferralLink?
    public var widgetTokens: [WidgetToken] = []
    public var overflowToolsLoaded = false
    /// The plaintext secret of a token just created — shown once, exactly
    /// like `apps/vet-web/public/app.js`'s `state.overflow.newSecret`, and
    /// cleared as soon as the operator dismisses it.
    public var newWidgetTokenSecret: String?

    public func loadOverflowTools() async {
        do {
            async let referralTask = api.getReferralLink()
            async let tokensTask = api.getWidgetTokens()
            referralLink = try await referralTask
            widgetTokens = try await tokensTask
            overflowToolsLoaded = true
        } catch let error as ClinicAPIError { fail(error.message) }
        catch { fail(error.localizedDescription) }
    }

    public func createWidgetToken(label: String, allowedOrigins: [String]) async {
        isBusy = true
        defer { isBusy = false }
        do {
            let token = try await api.createWidgetToken(label: label, allowedOrigins: allowedOrigins)
            newWidgetTokenSecret = token.secret
            succeed("Widget token created.")
            await loadOverflowTools()
        } catch let error as ClinicAPIError { fail(error.message) }
        catch { fail(error.localizedDescription) }
    }

    public func revokeWidgetToken(_ token: WidgetToken) async {
        isBusy = true
        defer { isBusy = false }
        do {
            try await api.revokeWidgetToken(id: token.id)
            succeed("Widget token revoked.")
            await loadOverflowTools()
        } catch let error as ClinicAPIError { fail(error.message) }
        catch { fail(error.localizedDescription) }
    }

    // MARK: - Payouts

    public var payouts = ClinicPayouts()
    public var payoutsLoaded = false

    /// Loaded once when the console opens, not on the poll loop. Money does
    /// not change every six seconds, and putting it on the same timer as the
    /// intake queue would mean six requests a minute per open console for a
    /// number that moves twice a day.
    public func loadPayouts() async {
        do {
            payouts = try await api.getPayouts()
            payoutsLoaded = true
        } catch let error as ClinicAPIError { fail(error.message) }
        catch { fail(error.localizedDescription) }
    }

    public func saveSettings() async {
        isBusy = true
        defer { isBusy = false }
        settingsStore.save(settings)
        api.updateSettings(settings)
        // A changed Worker address deserves a fresh verdict, not a backoff
        // inherited from the old one.
        consecutiveFailures = 0
        succeed("Settings saved.")
        await refresh(initial: true)
    }

    /// Persists just the floating console's geometry — called by
    /// `FloatingPanel` as it moves/resizes, without disturbing the rest of
    /// Settings or triggering a full save-and-reconnect.
    public func saveMiniWindowGeometry(left: Double, top: Double, width: Double, height: Double) {
        settings.miniWindowLeft = left
        settings.miniWindowTop = top
        settings.miniWindowWidth = width
        settings.miniWindowHeight = height
        settingsStore.save(settings)
    }

    private func applyAvailability(_ value: ClinicAvailability) {
        availabilityStatus = value.intakeStatus
        stableWaitMin = value.stableWaitMin ?? 15
        stableWaitMax = value.stableWaitMax ?? 35
        capacityCount = value.capacityCount ?? 0
        acceptsCritical = value.acceptsCritical
        publicNote = value.note ?? ""
        offerWaitMin = stableWaitMin
        offerWaitMax = stableWaitMax
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm:ss a"
        return formatter
    }()
}
