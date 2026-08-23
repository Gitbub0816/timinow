import Foundation
import Observation

// Swift port of apps/vet-windows/src/TimiVet/ViewModels/MainViewModel.cs.
// `@MainActor @Observable` plays the same role Skip's SwiftUI bridge expects
// as apps/customer-mobile/Sources/TimiNowCore/AppStore.swift.
@MainActor @Observable public final class ClinicStore {
    public var settings: AppSettings
    public var selectedRequest: ClinicRequest?
    public var isBusy = false
    public var statusMessage = "Connecting to Tími…"
    public var clinicName = "Tími veterinary console"
    public var clinicAddress = ""
    public var tenantName = ""
    public var userRole = ""
    public var connectionMode = "LIVE CLOUDFLARE CONNECTION"
    public var pending = 0
    public var activeArrivals = 0
    public var completedToday = 0
    public var declinedToday = 0

    public var requests: [ClinicRequest] = []
    public var pendingRequests: [ClinicRequest] = []

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
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    public var clampedPollSeconds: Int { min(60, max(3, settings.pollSeconds)) }

    public func refresh(initial: Bool) async {
        if isBusy && !initial { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let dashboard = try await api.getDashboard()
            connectionMode = api.isDemo ? "INTERACTIVE DEMO" : "LIVE CLOUDFLARE CONNECTION"
            pending = dashboard.metrics.pending
            activeArrivals = dashboard.metrics.activeArrivals
            completedToday = dashboard.metrics.completedToday
            declinedToday = dashboard.metrics.declinedToday
            applyAvailability(dashboard.location.availability)

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
            selectedRequest = requests.first(where: { $0.id == selectedId }) ?? pendingRequests.first
            initialized = true
            statusMessage = "Updated \(Self.timeFormatter.string(from: Date())) · next check in \(clampedPollSeconds) sec"
        } catch let error as ClinicAPIError {
            statusMessage = "Connection issue · \(error.message)"
        } catch {
            statusMessage = "Connection issue · \(error.localizedDescription)"
        }
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(clampedPollSeconds)) }
            catch { break }
            if Task.isCancelled { break }
            await refresh(initial: false)
        }
    }

    public func publish() async {
        if stableWaitMin > stableWaitMax { statusMessage = "Minimum wait cannot exceed maximum wait."; return }
        isBusy = true
        defer { isBusy = false }
        do {
            try await api.publishAvailability(AvailabilityUpdate(
                intakeStatus: availabilityStatus, stableWaitMin: stableWaitMin, stableWaitMax: stableWaitMax,
                capacityCount: capacityCount, ttlMinutes: ttlMinutes, acceptsCritical: acceptsCritical, note: publicNote
            ))
            statusMessage = "Live intake status published."
            await refresh(initial: true)
        } catch let error as ClinicAPIError { statusMessage = error.message }
        catch { statusMessage = error.localizedDescription }
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
        if !decline && offerWaitMin > offerWaitMax { statusMessage = "Offer minimum wait cannot exceed maximum wait."; return }
        isBusy = true
        defer { isBusy = false }
        do {
            let availableAtISO = responseType == "available_at" ? ISO8601DateFormatter().string(from: availableAt) : nil
            let decision = DecisionPayload(
                decision: decline ? "decline" : "offer", responseType: responseType, availableAt: availableAtISO,
                arrivalWindowMinutes: arrivalWindowMinutes, holdMinutes: holdMinutes, waitMin: offerWaitMin, waitMax: offerWaitMax, note: clinicNote
            )
            try await api.respond(to: request, decision: decision)
            statusMessage = decline
                ? "Declined \(request.pet.name)'s request."
                : (request.searchTarget ? "Availability offer sent for \(request.pet.name)." : "Arrival accepted for \(request.pet.name).")
            selectedRequest = nil
            clinicNote = ""
            await refresh(initial: true)
        } catch let error as ClinicAPIError { statusMessage = error.message }
        catch { statusMessage = error.localizedDescription }
    }

    // MARK: - Calling preferences

    public var callPreferences = CallPreferences()
    public var callPreferencesLoaded = false

    public func loadCallPreferences() async {
        do {
            callPreferences = try await api.getCallPreferences()
            callPreferencesLoaded = true
        } catch let error as ClinicAPIError { statusMessage = error.message }
        catch { statusMessage = error.localizedDescription }
    }

    public func saveCallPreferences(callsEnabled: Bool, voicePhone: String, quietStart: String, quietEnd: String) async {
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
                CallPreferencesUpdate(callsEnabled: callsEnabled, voicePhone: trimmedPhone, quietHours: quiet)
            )
            statusMessage = callsEnabled
                ? "Tími will call this clinic about new requests."
                : "Tími will not call this clinic. Requests still arrive in the console."
        } catch let error as ClinicAPIError { statusMessage = error.message }
        catch { statusMessage = error.localizedDescription }
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
        } catch let error as ClinicAPIError { statusMessage = error.message }
        catch { statusMessage = error.localizedDescription }
    }

    public func saveSettings() async {
        isBusy = true
        defer { isBusy = false }
        settingsStore.save(settings)
        api.updateSettings(settings)
        connectionMode = api.isDemo ? "INTERACTIVE DEMO" : "LIVE CLOUDFLARE CONNECTION"
        statusMessage = "Settings saved."
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
