import Foundation
import TimiVetCore
import SwiftUI

// SwiftUI port of apps/vet-windows/src/TimiVet/Views/MiniWindow.xaml — the
// content hosted inside FloatingPanel.swift's NSPanel.
public struct MiniConsoleView: View {
    @Bindable var store: ClinicStore
    var onOpenMain: () -> Void
    var onMinimize: (() -> Void)?
    var onHide: (() -> Void)?
    var onTopmostChanged: (() -> Void)?

    public init(
        store: ClinicStore, onOpenMain: @escaping () -> Void,
        onMinimize: (() -> Void)? = nil, onHide: (() -> Void)? = nil, onTopmostChanged: (() -> Void)? = nil
    ) {
        self.store = store
        self.onOpenMain = onOpenMain
        self.onMinimize = onMinimize
        self.onHide = onHide
        self.onTopmostChanged = onTopmostChanged
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            summary
            list
            footerControls
        }
        .background(TimiVetColor.miniCardBackground)
        .clipShape(RoundedRectangle(cornerRadius: TimiVetMetrics.miniRadius))
        .overlay(RoundedRectangle(cornerRadius: TimiVetMetrics.miniRadius).stroke(TimiVetColor.ink, lineWidth: 2))
    }

    private var header: some View {
        HStack {
            HStack(alignment: .lastTextBaseline, spacing: 2) {
                Text("Tími").font(TimiVetFont.display(22)).foregroundStyle(.white)
                Text(" NOW · LIVE").font(TimiVetFont.ui(9, weight: .bold)).foregroundStyle(TimiVetColor.coral)
            }
            Spacer()
            if let onMinimize {
                Button(action: onMinimize) { Image(systemName: "minus") }.buttonStyle(.plain).foregroundStyle(.white)
            }
            if let onHide {
                Button(action: onHide) { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(.white).padding(.leading, 6)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(TimiVetColor.ink)
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: TimiVetMetrics.miniRadius - 2, bottomLeadingRadius: 0, bottomTrailingRadius: 0, topTrailingRadius: TimiVetMetrics.miniRadius - 2))
    }

    private var summary: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(store.clinicName).font(TimiVetFont.ui(13, weight: .bold)).lineLimit(1)
                Text(store.statusMessage).font(TimiVetFont.ui(9)).foregroundStyle(TimiVetColor.muted).lineLimit(1)
            }
            Spacer()
            HStack(spacing: 4) {
                Text("\(store.pending)").font(TimiVetFont.ui(13, weight: .bold)).foregroundStyle(.white)
                Text("waiting").font(TimiVetFont.ui(10)).foregroundStyle(.white)
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(TimiVetColor.coral, in: Capsule())
        }
        .padding(EdgeInsets(top: 12, leading: 14, bottom: 8, trailing: 14))
    }

    private var list: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(store.pendingRequests) { request in
                    Button { store.select(request) } label: { row(request) }.buttonStyle(.plain)
                    Divider().foregroundStyle(TimiVetColor.miniDivider)
                }
                if store.pendingRequests.isEmpty {
                    Text("No pending requests.").font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted).padding(16)
                }
            }
        }
        .frame(maxHeight: .infinity)
        .padding(.horizontal, 8)
    }

    private func row(_ request: ClinicRequest) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(String(request.pet.name.prefix(2)))
                    .font(TimiVetFont.ui(11, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 32, height: 32).background(TimiVetColor.blue, in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text(request.petLine).font(TimiVetFont.ui(12, weight: .bold))
                    Text(request.concernSummary).font(TimiVetFont.ui(9)).foregroundStyle(TimiVetColor.muted).lineLimit(2)
                }
                Spacer()
                Text(request.travelLabel).font(TimiVetFont.ui(9))
            }
            // The answer, on the panel that raised the alert. "Open decision
            // workspace" was the only thing here, which turned a yes/no into
            // find-the-window-read-four-fields-press-a-button.
            HStack(spacing: 6) {
                Button("Yes") { Task { await store.answer(request, decline: false) } }
                    .buttonStyle(TimiVetPrimaryButtonStyle(color: TimiVetColor.blue))
                    .disabled(store.isBusy)
                Button("No") { Task { await store.answer(request, decline: true) } }
                    .buttonStyle(TimiVetQuietButtonStyle())
                    .disabled(store.isBusy)
            }
        }
        .padding(9)
    }

    private var footerControls: some View {
        HStack(spacing: 8) {
            Toggle("Always on top", isOn: Binding(
                get: { store.settings.miniWindowTopmost },
                set: { newValue in store.settings.miniWindowTopmost = newValue; onTopmostChanged?() }
            ))
            .toggleStyle(.checkbox)
            .font(TimiVetFont.ui(11))
            Spacer()
            // Demoted: answering is the common case and now happens on the
            // row above. This is for shaping an offer — a different arrival
            // window, a note, a time later today.
            Button("Open decision workspace", action: onOpenMain).buttonStyle(TimiVetQuietButtonStyle())
        }
        .padding(12)
    }
}
