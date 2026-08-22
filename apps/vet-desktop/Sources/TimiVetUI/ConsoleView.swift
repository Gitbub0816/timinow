import Foundation
import TimiVetCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

// SwiftUI port of apps/vet-windows/src/TimiVet/Views/MainWindow.xaml.
public struct ConsoleView: View {
    @Bindable var store: ClinicStore
    var onOpenMini: () -> Void
    var onManagePeople: () -> Void
    var onSignOut: () -> Void

    public init(store: ClinicStore, onOpenMini: @escaping () -> Void, onManagePeople: @escaping () -> Void, onSignOut: @escaping () -> Void) {
        self.store = store
        self.onOpenMini = onOpenMini
        self.onManagePeople = onManagePeople
        self.onSignOut = onSignOut
    }

    public var body: some View {
        HStack(spacing: 0) {
            sidebar.frame(width: 230)
            VStack(spacing: 0) {
                header
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        topRow
                        queueAndWorkspace
                        settingsSection
                    }
                    .padding(24)
                }
                footer
            }
            .background(TimiVetColor.canvas)
        }
        .background(TimiVetColor.canvas)
        .task { await store.start() }
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Image("timinow-wordmark", bundle: .module)
                    .resizable().scaledToFit().frame(width: 172, height: 60)
                    .accessibilityLabel("Tími NOW")
                Text("VETERINARY OPERATIONS").font(TimiVetFont.ui(10, weight: .bold)).foregroundStyle(TimiVetColor.railMutedText)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("LIVE OPERATIONS").font(TimiVetFont.ui(10, weight: .bold)).foregroundStyle(TimiVetColor.railFooterText)
                Text(store.clinicName).font(TimiVetFont.ui(17, weight: .semibold)).foregroundStyle(.white)
                Text(store.clinicAddress).font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.railMutedText)
                if !store.userRole.isEmpty {
                    Text(store.userRole.uppercased()).font(TimiVetFont.ui(10, weight: .bold)).foregroundStyle(TimiVetColor.railTag)
                }
            }
            .padding(.top, 42)
            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("CURRENT MODE").font(TimiVetFont.ui(9, weight: .bold)).foregroundStyle(TimiVetColor.railTag)
                    Text(store.connectionMode).font(TimiVetFont.ui(11, weight: .bold)).foregroundStyle(TimiVetColor.gold)
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(TimiVetColor.railDeepInk, in: RoundedRectangle(cornerRadius: 9))

                Button("Open floating console", action: onOpenMini).buttonStyle(TimiVetQuietButtonStyle())
                Button("Refresh now") { Task { await store.refresh(initial: false) } }.buttonStyle(TimiVetQuietButtonStyle())
                Button("Manage people", action: onManagePeople).buttonStyle(TimiVetQuietButtonStyle())
                Button("Sign out", action: onSignOut).buttonStyle(TimiVetQuietButtonStyle())
            }
            .padding(.top, 45)
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
        .background(TimiVetColor.ink)
    }

    // MARK: Header / footer

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text("IMMEDIATE INTAKE CONTROL").timiVetEyebrow()
                Text("Clinic operations").font(TimiVetFont.display(31))
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 8) {
                Text(store.statusMessage).font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
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
            Text("Tími NOW · ClearKey Solutions, LLC").font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 10)
        .background(Color.white)
        .overlay(Rectangle().frame(height: 1).foregroundStyle(TimiVetColor.cardBorder), alignment: .top)
    }

    // MARK: Public Capacity + metrics

    private var topRow: some View {
        HStack(alignment: .top, spacing: 18) {
            publicCapacityCard.frame(maxWidth: .infinity)
            metricsGrid.frame(maxWidth: .infinity)
        }
    }

    private var publicCapacityCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("PUBLIC CAPACITY").timiVetEyebrow()
            Text("What pet owners see right now").font(TimiVetFont.ui(20, weight: .semibold))
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Intake status").font(TimiVetFont.ui(13, weight: .semibold))
                    Picker("", selection: $store.availabilityStatus) {
                        ForEach(ClinicStore.availabilityStatuses, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) }
                    }.labelsHidden()
                    Text("Public note").font(TimiVetFont.ui(13, weight: .semibold))
                    TextField("Public note", text: $store.publicNote, axis: .vertical)
                        .lineLimit(3, reservesSpace: true)
                        .textFieldStyle(.roundedBorder)
                }
                VStack(alignment: .leading, spacing: 8) {
                    labeledIntField("Wait min", value: $store.stableWaitMin)
                    labeledIntField("Wait max", value: $store.stableWaitMax)
                    labeledIntField("Capacity", value: $store.capacityCount)
                    labeledIntField("Expires (min)", value: $store.ttlMinutes)
                    Toggle("Accepting critical patients", isOn: $store.acceptsCritical)
                    Button("Publish live status") { Task { await store.publish() } }.buttonStyle(TimiVetPrimaryButtonStyle())
                }
            }
        }
        .timiVetCard(TimiVetColor.publicCapacityBackground)
    }

    private var metricsGrid: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                metricCard("WAITING", store.pending)
                metricCard("ACTIVE ARRIVALS", store.activeArrivals)
            }
            HStack(spacing: 10) {
                metricCard("COMPLETED TODAY", store.completedToday)
                metricCard("DECLINED TODAY", store.declinedToday)
            }
        }
    }

    private func metricCard(_ title: String, _ value: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).timiVetEyebrow()
            Text("\(value)").font(TimiVetFont.display(30))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .timiVetCard()
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
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(store.requests) { request in
                        Button { store.select(request) } label: { requestRow(request) }
                            .buttonStyle(.plain)
                        Divider().foregroundStyle(TimiVetColor.cardBorderAlt)
                    }
                }
            }
            .frame(minHeight: 400, maxHeight: 520)
        }
        .timiVetCard()
        .padding(0)
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

    private var decisionWorkspace: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("DECISION WORKSPACE").timiVetEyebrow()
                if let request = store.selectedRequest {
                    Text(request.petLine).font(TimiVetFont.display(27))
                    Text(request.concernSummary).font(TimiVetFont.ui(15))
                    HStack(spacing: 18) {
                        ownerField("OWNER", request.owner.name)
                        ownerField("PHONE", request.owner.phone)
                        ownerField("TRAVEL", request.travelLabel)
                    }
                    Divider()
                    Text("Availability response").font(TimiVetFont.ui(17, weight: .semibold))
                    HStack(alignment: .top, spacing: 16) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Response type").font(TimiVetFont.ui(13, weight: .semibold))
                            Picker("", selection: $store.responseType) {
                                ForEach(ClinicStore.responseTypes, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) }
                            }.labelsHidden()
                            if store.responseType == "available_at" {
                                Text("Available at").font(TimiVetFont.ui(13, weight: .semibold))
                                DatePicker("", selection: $store.availableAt).labelsHidden()
                            }
                            Text("Message to pet owner").font(TimiVetFont.ui(13, weight: .semibold))
                            TextField("Message", text: $store.clinicNote, axis: .vertical)
                                .lineLimit(4, reservesSpace: true)
                                .textFieldStyle(.roundedBorder)
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            labeledIntField("Arrival window", value: $store.arrivalWindowMinutes)
                            labeledIntField("Offer hold", value: $store.holdMinutes)
                            labeledIntField("Wait min", value: $store.offerWaitMin)
                            labeledIntField("Wait max", value: $store.offerWaitMax)
                            Text("An offer does not book the patient. The owner may compare up to five responses. Unselected offers are released automatically.")
                                .font(TimiVetFont.ui(11))
                                .padding(12)
                                .background(TimiVetColor.offerBannerBackground, in: RoundedRectangle(cornerRadius: 10))
                        }
                    }
                    HStack(spacing: 12) {
                        Button("Decline request") { Task { await store.decline() } }.buttonStyle(TimiVetQuietButtonStyle())
                        Button("Send availability offer") { Task { await store.offer() } }.buttonStyle(TimiVetCoralButtonStyle())
                    }
                } else {
                    Text("Select a request").font(TimiVetFont.display(27)).foregroundStyle(TimiVetColor.muted)
                }
            }
        }
        .timiVetCard()
    }

    private func ownerField(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(TimiVetFont.ui(9, weight: .bold)).foregroundStyle(TimiVetColor.muted)
            Text(value).font(TimiVetFont.ui(13, weight: .semibold))
        }
    }

    // MARK: Settings

    private var settingsSection: some View {
        DisclosureGroup("Connection, alerts, and startup settings") {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Cloudflare Worker HTTPS URL").font(TimiVetFont.ui(13, weight: .semibold))
                    TextField("https://your-clinic.example.workers.dev", text: $store.settings.apiBaseUrl).textFieldStyle(.roundedBorder)
                    Text("Tenant ID (loopback demo header)").font(TimiVetFont.ui(13, weight: .semibold))
                    TextField("tenant_hearth", text: $store.settings.tenantId).textFieldStyle(.roundedBorder)
                    Text("Sign in above establishes the real Clerk session; this field only matters against a loopback dev Worker with no session.")
                        .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Polling interval, seconds").font(TimiVetFont.ui(13, weight: .semibold))
                    Stepper("\(store.settings.pollSeconds) sec", value: $store.settings.pollSeconds, in: 3...60)
                    Toggle("Desktop intake alerts", isOn: $store.settings.alertsEnabled)
                    Toggle("Play alert sound", isOn: $store.settings.playSound)
                    Toggle("Floating console stays on top", isOn: $store.settings.miniWindowTopmost)
                    Toggle("Floating console stays above everything (screen saver level)", isOn: $store.settings.stayAboveEverything)
                    Toggle("Open floating console automatically on a new request", isOn: $store.settings.autoShowMiniOnNewRequest)
                    Toggle("Start Tími Vet at login", isOn: $store.settings.startAtLogin)
                    Button("Save settings and reconnect") { Task { await store.saveSettings() } }.buttonStyle(TimiVetPrimaryButtonStyle())
                }
            }
            .padding(.top, 10)
        }
        .timiVetCard()
    }

    private func labeledIntField(_ title: String, value: Binding<Int>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(TimiVetFont.ui(12))
            TextField(title, value: value, format: .number).textFieldStyle(.roundedBorder).frame(width: 110)
        }
    }
}
