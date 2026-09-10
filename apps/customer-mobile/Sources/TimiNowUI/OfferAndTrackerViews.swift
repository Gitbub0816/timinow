import Foundation
import Observation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

struct OfferSearchView: View {
    @Bindable var store: AppStore
    @State var sort = "recommended"
    @State var appeared: Set<String> = []
    @State var lastOfferCount = 0
    /// The leave-confirmation card is up. Cancelling a live search releases
    /// every clinic currently holding a spot, so one stray tap on the ✕
    /// must not be able to do it alone.
    @State var confirmingCancel = false

    static let sortOptions: [(String, String)] = [
        ("recommended", "Recommended"), ("distance", "Closest"),
        ("wait", "Shortest wait"), ("cost", "Lowest deposit")
    ]

    var offers: [CareOffer] {
        let active = (store.currentSearch?.offers ?? []).filter { $0.status == "active" }
        let sorted: [CareOffer]
        switch sort {
        case "distance": sorted = active.sorted { ($0.location?.distanceMiles ?? 999) < ($1.location?.distanceMiles ?? 999) }
        case "wait": sorted = active.sorted { ($0.waitMin ?? 999) < ($1.waitMin ?? 999) }
        case "cost": sorted = active.sorted { ($0.depositAmountCents ?? 0) < ($1.depositAmountCents ?? 0) }
        default: sorted = active
        }
        return Array(sorted.prefix(5))
    }

    var body: some View {
        ZStack {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        HStack { Button { confirmingCancel = true } label: { Image(systemName: "xmark").frame(width: 42, height: 42).background(.white, in: Circle()).overlay(Circle().stroke(TimiColor.ink.faded(0.25))) }.buttonStyle(.plain).accessibilityLabel("Cancel this search"); Spacer(); TimiWordmark(compact: true) }
                        if offers.isEmpty { waitingView } else { offersView }
                    }.padding(20).padding(.bottom, 36)
                        // A comfortable column on a fold-open or landscape
                        // width; the offer grid below still gets two columns
                        // inside it.
                        .frame(maxWidth: 780)
                        .frame(maxWidth: .infinity)
                }.background(TimiColor.canvas)
            }
            if confirmingCancel {
                TimiConfirmCard(
                    title: "Cancel this search?",
                    message: "Cancelling releases every clinic currently answering for \(store.draft.pet.name) and lets any held offers go. To find care after that, you would start a new request.",
                    stayLabel: "Keep searching",
                    leaveLabel: "Cancel the search",
                    onStay: { confirmingCancel = false },
                    onLeave: { confirmingCancel = false; store.resetCareFlow() }
                ).zIndex(5).transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.16), value: confirmingCancel)
        .task {
            while store.route == .searching && ["collecting", "offers_ready"].contains(store.currentSearch?.status ?? "") {
                await store.refreshSearch(); try? await Task.sleep(for: .seconds(3))
            }
        }
        .onChange(of: offers.count) { count in
            if count > lastOfferCount && lastOfferCount > 0 { Task { await PlatformPermissions.notify(title: "A clinic can help \(store.draft.pet.name)", body: "You now have \(count) live Tími offer\(count == 1 ? "" : "s") to compare.") } }
            lastOfferCount = count
        }
    }

    var waitingView: some View {
        VStack(spacing: 20) {
            PulsingBeacon(symbol: "phone.arrow.up.right.fill")
            Eyebrow(text: "LIVE SEARCH IN PROGRESS")
            DisplayHeadline(text: "Asking nearby clinics now.", size: 40, alignment: .center)
            Text("You can choose as soon as an offer arrives. Tími stops after five responses or when the collection window closes.").font(.title3).foregroundStyle(TimiColor.muted).multilineTextAlignment(.center)
            HStack { MetricChip(title: "Contacted", value: "\(store.currentSearch?.progress?.contacted ?? 0)"); MetricChip(title: "Awaiting", value: "\(store.currentSearch?.progress?.awaiting ?? 0)", color: TimiColor.goldSoft) }
            SafetyBanner(compact: true, store: store)
        }.padding(.top, 18)
    }

    /// True while the Worker is still collecting answers, as distinct from
    /// having finished with however many it got.
    var stillCollecting: Bool { store.currentSearch?.status == "collecting" }
    var awaitingCount: Int { max(0, store.currentSearch?.progress?.awaiting ?? 0) }

    var headline: String {
        if stillCollecting { return "\(store.draft.pet.name) has an answer." }
        return offers.count == 1 ? "\(store.draft.pet.name) has one option." : "\(store.draft.pet.name) has options."
    }

    var offersView: some View {
        VStack(alignment: .leading, spacing: 17) {
            Eyebrow(text: "\(offers.count) OF \(store.currentSearch?.maxOffers ?? 5) OFFERS", color: TimiColor.blue)
            DisplayHeadline(text: headline, size: 40)
            Text("Compare the clinics below. Nothing is confirmed until you choose.").foregroundStyle(TimiColor.muted)
            // Offers appear the moment a clinic says yes, so the first one is
            // choosable while the rest are still being asked. Without saying
            // so, one offer on screen looks like the final answer — and
            // waiting for a second that may never come is exactly the delay
            // this app exists to remove.
            if stillCollecting {
                HStack(spacing: 10) {
                    ProgressView().tint(TimiColor.blue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Still asking \(awaitingCount) more clinic\(awaitingCount == 1 ? "" : "s")")
                            .font(.callout).fontWeight(.black)
                        Text("You can take one of these now — the rest are released the moment you do.")
                            .font(.caption).foregroundStyle(TimiColor.muted)
                    }
                    Spacer()
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(TimiColor.blueSoft, in: RoundedRectangle(cornerRadius: 15))
            } else {
                Text(offers.count == 1
                    ? "One clinic answered. That is the whole answer for now — the rest declined or did not respond in time."
                    : "\(offers.count) clinics answered. Asking has finished.")
                    .font(.caption).fontWeight(.semibold).foregroundStyle(TimiColor.muted)
            }
            ClinicMapView(
                clinics: offers.compactMap(\.location),
                selectedClinicId: nil,
                userLatitude: store.currentLatitude,
                userLongitude: store.currentLongitude,
                styleURL: store.mapStyleURL
            ).frame(height: 220).clipShape(RoundedRectangle(cornerRadius: 20)).overlay(RoundedRectangle(cornerRadius: 20).stroke(TimiColor.ink, lineWidth: 2))
            // The app's own chips, not the system's grey segmented picker —
            // the last visibly stock control on this screen.
            TimiSegmentChips(options: Self.sortOptions, selection: $sort)
            // Adaptive columns: one on a phone, two the moment the width
            // allows (landscape, or a fold-open screen), so a wide display
            // compares offers side by side instead of stretching each card.
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 330), spacing: 14, alignment: .top)], spacing: 14) {
                ForEach(Array(offers.enumerated()), id: \.element.id) { index, offer in
                    OfferCard(offer: offer, rank: index + 1, isWorking: store.isWorking) { Task { await store.selectOffer(offer) } }
                        .offset(y: CGFloat(appeared.contains(offer.id) ? 0 : 22)).opacity(Double(appeared.contains(offer.id) ? 1 : 0))
                        .onAppear { withAnimation(.spring(response: 0.4, dampingFraction: 0.84).delay(Double(index) * 0.06)) { _ = appeared.insert(offer.id) } }
                }
            }
            Text("Availability and waits are reported by clinics and may change. Emergency hospitals independently triage every arriving patient.").font(.caption).foregroundStyle(TimiColor.muted).padding(.top, 6)
        }
    }
}

struct OfferCard: View {
    var offer: CareOffer; var rank: Int; var isWorking: Bool; var select: () -> Void
    @State var details = false
    /// A masked offer (the default until the customer selects one — see
    /// `MaskedMatchCard`) has no real clinic to show, so this stands in
    /// with the temporary alias name and the facts that survive masking.
    /// `address`/`phone` are left nil either way: the existing "Address
    /// shown on confirmation" copy below already covers that case.
    var clinic: ClinicLocation {
        if let location = offer.location { return location }
        if let masked = offer.maskedCard {
            return ClinicLocation(
                id: masked.matchToken ?? offer.id,
                name: masked.alias?.displayName ?? "New clinic match",
                distanceMiles: masked.timinow?.distanceMiles
            )
        }
        return ClinicLocation(id: offer.locationId ?? offer.id, name: "Veterinary clinic")
    }
    var isEmergency: Bool { offer.responseType == "emergency_intake" }

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .top, spacing: 13) {
                Text("\(rank)").font(.system(size: 21, weight: .black, design: .serif)).frame(width: 44, height: 44).background(rank == 1 ? TimiColor.gold : TimiColor.blueSoft, in: Circle()).overlay(Circle().stroke(TimiColor.ink, lineWidth: 2))
                VStack(alignment: .leading, spacing: 4) { Eyebrow(text: isEmergency ? "EMERGENCY INTAKE OPEN" : "AVAILABLE NOW", color: isEmergency ? TimiColor.coral : TimiColor.blue); Text(clinic.name).font(.title3).fontWeight(.black); Text(clinic.address ?? "Address shown on confirmation").font(.caption).foregroundStyle(TimiColor.muted) }
            }
            StaffingNotice(notice: clinic.staffingNotice)
            HStack(spacing: 8) { MetricChip(title: "Travel", value: clinic.distanceMiles.map { String(format: "%.1f mi", $0) } ?? "—"); MetricChip(title: "Reported wait", value: TimiFormat.wait(offer.waitMin, offer.waitMax), color: TimiColor.goldSoft) }
            HStack(spacing: 8) { MetricChip(title: "Deposit", value: TimiFormat.money(offer.depositAmountCents)); MetricChip(title: "Exam fee", value: (offer.baseExamFeeCents ?? 0) > 0 ? "From \(TimiFormat.money(offer.baseExamFeeCents))" : "Not supplied", color: TimiColor.coralSoft) }
            if details { VStack(alignment: .leading, spacing: 8) { Label(offer.clinicNote ?? "The clinic reports capacity for this arrival window.", systemImage: "quote.bubble.fill"); Label("Held temporarily while you compare", systemImage: "timer"); if isEmergency { Label("Examination priority is determined by clinical triage", systemImage: "cross.case.fill") } }.font(.caption).foregroundStyle(TimiColor.muted).transition(.opacity.combined(with: .move(edge: .top))) }
            HStack { Button(details ? "Less" : "Details") { withAnimation(.spring(response: 0.35)) { details.toggle() } }.font(.caption).fontWeight(.black).foregroundStyle(TimiColor.blue); Spacer(); Text("Temporary hold").font(.caption2).fontWeight(.bold).foregroundStyle(TimiColor.muted) }
            Button(action: select) { HStack { if isWorking { ProgressView().tint(.white) }; Text("Choose \(clinic.name)").lineLimit(1); Image(systemName: "arrow.right") } }.buttonStyle(TimiPrimaryButtonStyle(color: isEmergency ? TimiColor.coral : TimiColor.blue)).disabled(isWorking)
        }.timiCard(isEmergency ? TimiColor.coralSoft : .white)
    }
}

struct TrackerView: View {
    @Bindable var store: AppStore
    @State var showNavigation = false
    @State var routePreview: [GeoPoint] = []
    /// The leave-confirmation card is up. "Finish and return home" used to
    /// fire on the first tap, and one stray thumb lost the tracking screen.
    @State var confirmingFinish = false
    var intake: CareIntake? { store.currentIntake }
    var clinic: ClinicLocation? { intake?.location }

    var navigationDestination: NavigationDestination? {
        guard let clinic, let latitude = clinic.latitude, let longitude = clinic.longitude else { return nil }
        return NavigationDestination(clinicId: clinic.id, name: clinic.name, address: clinic.address ?? "", latitude: latitude, longitude: longitude, phone: clinic.phone, kind: clinic.kind)
    }

    var body: some View {
        // The width probe drives the fold-open / landscape layout below.
        // GeometryReader rather than a size-class environment read because
        // this module also compiles for Android through Skip, where measured
        // width is the one signal guaranteed to exist.
        GeometryReader { proxy in
            ZStack {
                NavigationStack {
                    ScrollView {
                        trackerContent(isWide: proxy.size.width >= 660)
                            .padding(20).padding(.bottom, 34)
                            .frame(maxWidth: 980)
                            .frame(maxWidth: .infinity)
                    }.background(TimiColor.canvas)
                }
                if confirmingFinish {
                    TimiConfirmCard(
                        title: "Leave the tracker?",
                        message: "\(intake?.pet?.name ?? store.selectedPet.name)'s visit stays booked — the clinic is still expecting you. Finishing only closes this screen; the visit is kept under Activity, and closing the app instead brings you straight back here.",
                        stayLabel: "Keep tracking",
                        leaveLabel: "Finish",
                        onStay: { confirmingFinish = false },
                        onLeave: { confirmingFinish = false; store.resetCareFlow() }
                    ).zIndex(5).transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.16), value: confirmingFinish)
        }
        .task {
            guard let destination = navigationDestination else { return }
            let origin = GeoPoint(latitude: store.currentLatitude, longitude: store.currentLongitude)
            let preview = await RoutePreviewFetcher.fetch(
                from: origin,
                to: GeoPoint(latitude: destination.latitude, longitude: destination.longitude),
                preferences: store.navigationPreferences,
                mapToken: store.mapToken ?? ""
            )
            routePreview = preview?.coordinates ?? []
            if let summary = preview?.summary { store.updateNavigationProgress(step: store.currentNavigationStep, summary: summary) }
        }
        .onAppear {
            guard ["accepted", "en_route"].contains(intake?.status ?? "") else { return }
            // Ask for the combined booking payment once per appearance —
            // `store.bookingPayment == nil` guards a redraw from asking
            // twice. Arming the geofence is deliberately not gated on this
            // same condition: it waits for `bookingPaymentSettled`, handled
            // below and by the `.onChange` beneath it, since a geofence
            // arming before the customer has even confirmed the clinic
            // exists to them (by paying) makes no sense.
            if store.bookingPayment == nil { Task { await store.prepareBookingPayment() } }
            if store.bookingPaymentSettled { Task { await beginArrivalAutomation() } }
        }
        .onChange(of: store.bookingPaymentSettled) { settled in
            // Settlement can land a few seconds after this view already
            // appeared — the customer pays while looking at the screen — so
            // the `.onAppear` check above alone would miss it.
            guard settled, ["accepted", "en_route"].contains(intake?.status ?? "") else { return }
            Task { await beginArrivalAutomation() }
        }
        .onDisappear { PlatformPermissions.stopArrivalTracking(); store.arrivalAutomationEnabled = false }
        // fullScreenCover does not exist on macOS. The customer app ships to
        // iOS and Android only — macOS is just the host `swift test` builds
        // for — so the macOS branch only has to compile, not look right.
        #if os(macOS)
        .sheet(isPresented: $showNavigation) {
            if let destination = navigationDestination { NavigationScreen(store: store, destination: destination, onFinish: { showNavigation = false }) }
        }
        #else
        .fullScreenCover(isPresented: $showNavigation) {
            // "End navigation" cleared `store.navigationDestination`, which is
            // not what this cover is bound to, so the screen stayed up and the
            // only way out was to force-quit.
            if let destination = navigationDestination { NavigationScreen(store: store, destination: destination, onFinish: { showNavigation = false }) }
        }
        #endif
    }

    /// The screen's content, in one column on a phone and two beside each
    /// other — map and timeline left, clinic card and actions right — when
    /// the width allows (landscape, or a fold-open screen).
    @ViewBuilder func trackerContent(isWide: Bool) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack { TimiWordmark(compact: true); Spacer(); Text(intake?.publicCode ?? "CONFIRMED").font(.caption).fontWeight(.black).foregroundStyle(TimiColor.blue) }
            Eyebrow(text: "CLINIC SELECTED", color: TimiColor.blue)
            DisplayHeadline(text: "\(intake?.pet?.name ?? store.selectedPet.name) has a place to go.", size: 41)
            // Clinic details — the map, the address/phone/Navigate
            // card, and the arrival-status buttons — all reveal or
            // act on the clinic's exact location, which now waits
            // for the combined booking payment (Tími's own fee, plus
            // any clinic-required arrival deposit) to settle. The old
            // standalone `DepositSection` is not shown here anymore:
            // `BookingPaymentSection` already collects any clinic
            // deposit as part of the one combined charge, so showing
            // both would double-prompt for money.
            if store.bookingPaymentSettled {
                if isWide {
                    HStack(alignment: .top, spacing: 18) {
                        VStack(alignment: .leading, spacing: 20) {
                            clinicMap(height: 300)
                            timeline
                        }.frame(maxWidth: .infinity)
                        VStack(alignment: .leading, spacing: 20) {
                            clinicCard
                            actionButtons
                        }.frame(maxWidth: .infinity)
                    }
                } else {
                    timeline
                    clinicMap(height: 220)
                    clinicCard
                    actionButtons
                }
            } else {
                timeline
                BookingPaymentSection(store: store)
            }
            SafetyBanner(compact: true)
            Button("Finish and return home") { confirmingFinish = true }.buttonStyle(TimiQuietButtonStyle())
        }
    }

    @ViewBuilder func clinicMap(height: CGFloat) -> some View {
        if let clinic {
            ClinicMapView(
                clinics: [clinic],
                selectedClinicId: clinic.id,
                userLatitude: store.currentLatitude,
                userLongitude: store.currentLongitude,
                styleURL: store.mapStyleURL,
                routeCoordinates: routePreview
            ).frame(height: height).clipShape(RoundedRectangle(cornerRadius: 20)).overlay(RoundedRectangle(cornerRadius: 20).stroke(TimiColor.ink, lineWidth: 2))
        }
    }

    var clinicCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Image(systemName: "building.2.fill").font(.title).foregroundStyle(.white).frame(width: 54, height: 54).background(TimiColor.blue, in: RoundedRectangle(cornerRadius: 16)); VStack(alignment: .leading) { Text(clinic?.name ?? "Veterinary clinic").font(.title3).fontWeight(.black); Text(clinic?.address ?? "Address unavailable").font(.caption).foregroundStyle(TimiColor.muted) } }
            StaffingNotice(notice: clinic?.staffingNotice)
            Divider(); Text(intake?.clinicNote ?? "The clinic is expecting your arrival. Capacity and clinical priority can still change.").font(.callout)
            HStack { if let phone = clinic?.phone, let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") { Link(destination: url) { Label("Call", systemImage: "phone.fill") } }; Spacer(); Button { startNavigating() } label: { Label("Navigate", systemImage: "arrow.triangle.turn.up.right.diamond.fill") }.disabled(navigationDestination == nil) }.fontWeight(.bold).foregroundStyle(TimiColor.blue)
        }.timiCard(Color.white)
    }

    var timeline: some View {
        VStack(alignment: .leading, spacing: 16) { Eyebrow(text: "ARRIVAL PROGRESS"); timelineRow(true, "Clinic confirmed", "Your selected offer is secured."); timelineRow(["en_route", "arrived", "triaged", "seen", "completed"].contains(intake?.status ?? ""), "On the way", "Tell the team when you leave."); timelineRow(["arrived", "triaged", "seen", "completed"].contains(intake?.status ?? ""), "Arrived", "Clinical triage determines treatment order."); timelineRow(["seen", "completed"].contains(intake?.status ?? ""), "Seen", "Your observation helps improve future estimates.") }.timiCard(TimiColor.paper)
    }

    func timelineRow(_ complete: Bool, _ title: String, _ detail: String) -> some View { HStack(alignment: .top, spacing: 13) { Image(systemName: complete ? "checkmark.circle.fill" : "circle").font(.title2).foregroundStyle(complete ? TimiColor.blue : TimiColor.ink.opacity(0.2)); VStack(alignment: .leading) { Text(title).fontWeight(.bold); Text(detail).font(.caption).foregroundStyle(TimiColor.muted) } } }

    /// Opening in-app turn-by-turn is itself the "I'm leaving" signal — no
    /// reason to also make the customer tap a separate button to say so.
    /// The manual "We're leaving now" button below still covers driving
    /// there without in-app navigation (or declining it and going anyway).
    func startNavigating() {
        showNavigation = true
        if intake?.status == "accepted" { Task { await store.updateIntake(status: "en_route") } }
    }

    /// Arms geofences around wherever the customer is now and the clinic so
    /// leaving marks "en_route" and arriving marks "arrived" with no taps.
    /// Silently no-ops on anything short of full cooperation (no clinic
    /// coordinates, Always permission declined, no location fix available)
    /// — the manual buttons in `actionButtons` are always still there.
    func beginArrivalAutomation() async {
        guard let clinic, let clinicLatitude = clinic.latitude, let clinicLongitude = clinic.longitude else { return }
        guard await PlatformPermissions.requestAlwaysLocation() else { return }
        guard let origin = await PlatformPermissions.currentLocation() else { return }
        store.arrivalAutomationEnabled = true
        PlatformPermissions.startArrivalTracking(
            originLatitude: origin.0, originLongitude: origin.1,
            clinicLatitude: clinicLatitude, clinicLongitude: clinicLongitude,
            onLeftOrigin: { [weak store] in
                Task { @MainActor [weak store] in
                    guard let store, store.currentIntake?.status == "accepted" else { return }
                    await store.updateIntake(status: "en_route")
                }
            },
            onArrivedAtClinic: { [weak store] in
                Task { @MainActor [weak store] in
                    guard let store, store.currentIntake?.status == "en_route" else { return }
                    await store.record("arrived")
                }
            }
        )
    }

    /// One button for whatever comes next, not one per step. The timeline
    /// above already shows every step; stacking a button per step next to it
    /// repeated the same information and, at "accepted", showed both
    /// "We're leaving now" and "We arrived" at once — offering to mark
    /// arrival before the customer had even left.
    @ViewBuilder var actionButtons: some View {
        switch intake?.status {
        case "accepted", "en_route":
            VStack(alignment: .leading, spacing: 10) {
                if store.arrivalAutomationEnabled {
                    Label("Tími is tracking your arrival automatically. Tap below only if that's wrong.", systemImage: "location.fill")
                        .font(.caption).fontWeight(.semibold).foregroundStyle(TimiColor.blue)
                }
                if intake?.status == "accepted" {
                    if store.arrivalAutomationEnabled {
                        Button { Task { await store.updateIntake(status: "en_route") } } label: { Label("We're leaving now", systemImage: "car.fill") }.buttonStyle(TimiQuietButtonStyle())
                    } else {
                        Button { Task { await store.updateIntake(status: "en_route") } } label: { Label("We're leaving now", systemImage: "car.fill") }.buttonStyle(TimiPrimaryButtonStyle())
                    }
                } else {
                    if store.arrivalAutomationEnabled {
                        Button { Task { await store.record("arrived") } } label: { Label("We arrived", systemImage: "mappin.circle.fill") }.buttonStyle(TimiQuietButtonStyle())
                    } else {
                        Button { Task { await store.record("arrived") } } label: { Label("We arrived", systemImage: "mappin.circle.fill") }.buttonStyle(TimiPrimaryButtonStyle())
                    }
                }
            }
        case "arrived", "triaged":
            Button { Task { await store.record("seen") } } label: { Label("My pet was seen", systemImage: "checkmark.seal.fill") }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue))
        default:
            EmptyView()
        }
    }
}
