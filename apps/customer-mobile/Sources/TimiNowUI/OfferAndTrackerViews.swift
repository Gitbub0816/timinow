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
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack { Button { store.resetCareFlow() } label: { Image(systemName: "xmark").frame(width: 42, height: 42).background(.white, in: Circle()) }; Spacer(); TimiWordmark(compact: true) }
                    if offers.isEmpty { waitingView } else { offersView }
                }.padding(20).padding(.bottom, 36)
            }.background(TimiColor.canvas)
        }
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
            Text("Asking nearby clinics now.").font(.system(size: 40, weight: .bold, design: .serif)).multilineTextAlignment(.center)
            Text("You can choose as soon as an offer arrives. Tími stops after five responses or when the collection window closes.").font(.title3).foregroundStyle(TimiColor.muted).multilineTextAlignment(.center)
            HStack { MetricChip(title: "Contacted", value: "\(store.currentSearch?.progress?.contacted ?? 0)"); MetricChip(title: "Awaiting", value: "\(store.currentSearch?.progress?.awaiting ?? 0)", color: TimiColor.goldSoft) }
            SafetyBanner(compact: true, store: store)
        }.padding(.top, 18)
    }

    var offersView: some View {
        VStack(alignment: .leading, spacing: 17) {
            Eyebrow(text: "\(offers.count) OF \(store.currentSearch?.maxOffers ?? 5) OFFERS", color: TimiColor.blue)
            Text("\(store.draft.pet.name) has options.").font(.system(size: 40, weight: .bold, design: .serif))
            Text("Compare the clinics below. Nothing is confirmed until you choose.").foregroundStyle(TimiColor.muted)
            ClinicMapView(
                clinics: offers.compactMap(\.location),
                selectedClinicId: nil,
                userLatitude: store.currentLatitude,
                userLongitude: store.currentLongitude,
                styleURL: store.mapStyleURL
            ).frame(height: 220).clipShape(RoundedRectangle(cornerRadius: 20)).overlay(RoundedRectangle(cornerRadius: 20).stroke(TimiColor.ink, lineWidth: 2))
            Picker("Sort offers", selection: $sort) { Text("Recommended").tag("recommended"); Text("Closest").tag("distance"); Text("Shortest wait").tag("wait"); Text("Lowest deposit").tag("cost") }.pickerStyle(.segmented)
            ForEach(Array(offers.enumerated()), id: \.element.id) { index, offer in
                OfferCard(offer: offer, rank: index + 1, isWorking: store.isWorking) { Task { await store.selectOffer(offer) } }
                    .offset(y: CGFloat(appeared.contains(offer.id) ? 0 : 22)).opacity(Double(appeared.contains(offer.id) ? 1 : 0))
                    .onAppear { withAnimation(.spring(response: 0.48, dampingFraction: 0.82).delay(Double(index) * 0.08)) { _ = appeared.insert(offer.id) } }
            }
            Text("Availability and waits are reported by clinics and may change. Emergency hospitals independently triage every arriving patient.").font(.caption).foregroundStyle(TimiColor.muted).padding(.top, 6)
        }
    }
}

struct OfferCard: View {
    var offer: CareOffer; var rank: Int; var isWorking: Bool; var select: () -> Void
    @State var details = false
    var clinic: ClinicLocation { offer.location ?? ClinicLocation(id: offer.locationId, name: "Veterinary clinic") }
    var isEmergency: Bool { offer.responseType == "emergency_intake" }

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .top, spacing: 13) {
                Text("\(rank)").font(.system(size: 21, weight: .black, design: .serif)).frame(width: 44, height: 44).background(rank == 1 ? TimiColor.gold : TimiColor.blueSoft, in: Circle()).overlay(Circle().stroke(TimiColor.ink, lineWidth: 2))
                VStack(alignment: .leading, spacing: 4) { Eyebrow(text: isEmergency ? "EMERGENCY INTAKE OPEN" : "AVAILABLE NOW", color: isEmergency ? TimiColor.coral : TimiColor.blue); Text(clinic.name).font(.title3).fontWeight(.black); Text(clinic.address ?? "Address shown on confirmation").font(.caption).foregroundStyle(TimiColor.muted) }
            }
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
    var intake: CareIntake? { store.currentIntake }
    var clinic: ClinicLocation? { intake?.location }

    var navigationDestination: NavigationDestination? {
        guard let clinic, let latitude = clinic.latitude, let longitude = clinic.longitude else { return nil }
        return NavigationDestination(clinicId: clinic.id, name: clinic.name, address: clinic.address ?? "", latitude: latitude, longitude: longitude, phone: clinic.phone, kind: clinic.kind)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack { TimiWordmark(compact: true); Spacer(); Text(intake?.publicCode ?? "CONFIRMED").font(.caption).fontWeight(.black).foregroundStyle(TimiColor.blue) }
                    Eyebrow(text: "CLINIC SELECTED", color: TimiColor.blue)
                    Text("\(intake?.pet?.name ?? store.selectedPet.name) has a place to go.").font(.system(size: 41, weight: .bold, design: .serif))
                    if let clinic {
                        ClinicMapView(
                            clinics: [clinic],
                            selectedClinicId: clinic.id,
                            userLatitude: store.currentLatitude,
                            userLongitude: store.currentLongitude,
                            styleURL: store.mapStyleURL,
                            routeCoordinates: routePreview
                        ).frame(height: 220).clipShape(RoundedRectangle(cornerRadius: 20)).overlay(RoundedRectangle(cornerRadius: 20).stroke(TimiColor.ink, lineWidth: 2))
                    }
                    clinicCard
                    timeline
                    if (intake?.depositAmountCents ?? 0) > 0 { depositCard }
                    actionButtons
                    SafetyBanner(compact: true)
                    Button("Finish and return home") { store.resetCareFlow() }.buttonStyle(TimiQuietButtonStyle())
                }.padding(20).padding(.bottom, 34)
            }.background(TimiColor.canvas)
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
        // fullScreenCover does not exist on macOS. The customer app ships to
        // iOS and Android only — macOS is just the host `swift test` builds
        // for — so the macOS branch only has to compile, not look right.
        #if os(macOS)
        .sheet(isPresented: $showNavigation) {
            if let destination = navigationDestination { NavigationScreen(store: store, destination: destination) }
        }
        #else
        .fullScreenCover(isPresented: $showNavigation) {
            if let destination = navigationDestination { NavigationScreen(store: store, destination: destination) }
        }
        #endif
    }

    var clinicCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Image(systemName: "building.2.fill").font(.title).foregroundStyle(.white).frame(width: 54, height: 54).background(TimiColor.blue, in: RoundedRectangle(cornerRadius: 16)); VStack(alignment: .leading) { Text(clinic?.name ?? "Veterinary clinic").font(.title3).fontWeight(.black); Text(clinic?.address ?? "Address unavailable").font(.caption).foregroundStyle(TimiColor.muted) } }
            Divider(); Text(intake?.clinicNote ?? "The clinic is expecting your arrival. Capacity and clinical priority can still change.").font(.callout)
            HStack { if let phone = clinic?.phone, let url = URL(string: "tel:\(phone.filter { $0.isNumber || $0 == "+" })") { Link(destination: url) { Label("Call", systemImage: "phone.fill") } }; Spacer(); Button { showNavigation = true } label: { Label("Navigate", systemImage: "arrow.triangle.turn.up.right.diamond.fill") }.disabled(navigationDestination == nil) }.fontWeight(.bold).foregroundStyle(TimiColor.blue)
        }.timiCard(Color.white)
    }

    var timeline: some View {
        VStack(alignment: .leading, spacing: 16) { Eyebrow(text: "ARRIVAL PROGRESS"); timelineRow(true, "Clinic confirmed", "Your selected offer is secured."); timelineRow(["en_route", "arrived", "triaged", "seen", "completed"].contains(intake?.status ?? ""), "On the way", "Tell the team when you leave."); timelineRow(["arrived", "triaged", "seen", "completed"].contains(intake?.status ?? ""), "Arrived", "Clinical triage determines treatment order."); timelineRow(["seen", "completed"].contains(intake?.status ?? ""), "Seen", "Your observation helps improve future estimates.") }.timiCard(TimiColor.paper)
    }

    func timelineRow(_ complete: Bool, _ title: String, _ detail: String) -> some View { HStack(alignment: .top, spacing: 13) { Image(systemName: complete ? "checkmark.circle.fill" : "circle").font(.title2).foregroundStyle(complete ? TimiColor.blue : TimiColor.ink.opacity(0.2)); VStack(alignment: .leading) { Text(title).fontWeight(.bold); Text(detail).font(.caption).foregroundStyle(TimiColor.muted) } } }

    var depositCard: some View {
        VStack(alignment: .leading, spacing: 11) { Eyebrow(text: intake?.paymentStatus == "paid" ? "DEPOSIT PAID" : "ARRIVAL DEPOSIT"); HStack { Text(TimiFormat.money(intake?.depositAmountCents)).font(.system(size: 34, weight: .bold, design: .serif)); Spacer(); Image(systemName: intake?.paymentStatus == "paid" ? "checkmark.shield.fill" : "creditcard.fill").font(.title).foregroundStyle(TimiColor.blue) }; Text("The deposit is credited to the clinic's invoice. Remaining veterinary charges are billed by the clinic; Tími does not submit insurance claims.").font(.caption).foregroundStyle(TimiColor.muted); if intake?.paymentStatus != "paid" { Button("Complete deposit") { if store.isDemoMode, var value = store.currentIntake { value.paymentStatus = "paid"; store.currentIntake = value } else { store.errorMessage = "Secure native Stripe Payment Sheet activates when the production Stripe mobile configuration is added." } }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue)) } }.timiCard(TimiColor.goldSoft)
    }

    var actionButtons: some View {
        VStack(spacing: 11) {
            if intake?.status == "accepted" { Button { Task { await store.updateIntake(status: "en_route") } } label: { Label("We're leaving now", systemImage: "car.fill") }.buttonStyle(TimiPrimaryButtonStyle()) }
            if ["en_route", "accepted"].contains(intake?.status ?? "") { Button { Task { await store.record("arrived") } } label: { Label("We arrived", systemImage: "mappin.circle.fill") }.buttonStyle(TimiQuietButtonStyle()) }
            if ["arrived", "triaged"].contains(intake?.status ?? "") { Button { Task { await store.record("seen") } } label: { Label("My pet was seen", systemImage: "checkmark.seal.fill") }.buttonStyle(TimiPrimaryButtonStyle(color: TimiColor.blue)) }
        }
    }
}
