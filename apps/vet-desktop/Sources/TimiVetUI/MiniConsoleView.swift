import Foundation
import TimiVetCore
import SwiftUI

// The floating pill hosted inside FloatingPanel.swift's NSPanel.
//
// Two states, one job:
//
// - Idle: a tight navy capsule — the Tími mark, a status dot, the pending
//   count if nonzero. Minimize/hide only appear on hover. Nothing else; a
//   panel that is on screen all day earns its place by being small.
// - A request is waiting: the pill grows into a card showing who is coming
//   (pet + species), how urgent, the concern one-liner and travel context —
//   with the decision *on the pill*: "Available now" / "Decline" call the
//   same `ClinicStore.answer` one-press path the workspace uses. "Open
//   decision workspace" stays for shaping a custom offer or an emergency
//   intake. Answering (or the queue emptying) collapses it back; more than
//   one waiting shows as "+N more" and the card advances to the next.
//
// The host panel reads the measured content size via `onContentSizeChange`
// and animates its frame to match — see FloatingPanel.fit(to:). The
// "always on top" toggle that used to live here moved to Clinic settings
// (ConsoleView.floatingConsoleCard); FloatingPanel observes the setting
// directly, so this view no longer needs a topmost callback.
public struct MiniConsoleView: View {
    @Bindable var store: ClinicStore
    var onOpenMain: () -> Void
    var onMinimize: (() -> Void)?
    var onHide: (() -> Void)?
    var onContentSizeChange: ((CGSize) -> Void)?

    @State private var isHovering = false

    public init(
        store: ClinicStore, onOpenMain: @escaping () -> Void,
        onMinimize: (() -> Void)? = nil, onHide: (() -> Void)? = nil,
        onContentSizeChange: ((CGSize) -> Void)? = nil
    ) {
        self.store = store
        self.onOpenMain = onOpenMain
        self.onMinimize = onMinimize
        self.onHide = onHide
        self.onContentSizeChange = onContentSizeChange
    }

    public var body: some View {
        Group {
            if let request = store.pendingRequests.first {
                expandedCard(request)
            } else {
                compactPill
            }
        }
        .onHover { hovering in
            withAnimation(.easeOut(duration: 0.12)) { isHovering = hovering }
        }
        // Growth and collapse, plus advancing to the next patient after an
        // answer, all key off which request (if any) leads the queue.
        .animation(.spring(response: 0.32, dampingFraction: 0.82), value: store.pendingRequests.first?.id)
        .background(GeometryReader { proxy in
            Color.clear.preference(key: MiniConsoleSizeKey.self, value: proxy.size)
        })
        .onPreferenceChange(MiniConsoleSizeKey.self) { size in
            onContentSizeChange?(size)
        }
        // Anchored top-trailing so that while the panel's frame animation
        // catches up with the content, the pill hangs from the window's
        // top-right corner instead of jumping around inside it — the same
        // corner FloatingPanel keeps fixed when it resizes.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
    }

    // MARK: - Idle: the compact pill

    private var compactPill: some View {
        HStack(spacing: 8) {
            Text("Tími").font(TimiVetFont.display(15)).foregroundStyle(.white)
            Circle().fill(statusColor).frame(width: 7, height: 7)
            if store.pending > 0 {
                Text("\(store.pending)")
                    .font(TimiVetFont.ui(10, weight: .bold)).foregroundStyle(.white)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(TimiVetColor.coral, in: Capsule())
            }
            if isHovering { hoverControls }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(TimiVetColor.navy, in: Capsule())
        .overlay(Capsule().stroke(Color.white.opacity(0.15), lineWidth: 1))
    }

    /// Same semantics as the main console's connection chip, now off the
    /// real state machine: green live, gold demo — plus coral for any state
    /// where the queue might be stale, which is the one thing the pill must
    /// not hide.
    private var statusColor: Color {
        if !store.isConnectionHealthy { return TimiVetColor.coral }
        return store.connectionState == .demo ? TimiVetColor.gold : TimiVetColor.green
    }

    /// Minimize/hide, demoted to hover-only: always-visible window chrome on
    /// an always-visible pill was most of the pill.
    private var hoverControls: some View {
        HStack(spacing: 10) {
            if let onMinimize {
                Button(action: onMinimize) { Image(systemName: "minus") }.buttonStyle(.plain).accessibilityLabel("Minimize")
            }
            if let onHide {
                Button(action: onHide) { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel("Hide — alerts keep running in the tray")
            }
        }
        .font(.system(size: 9, weight: .bold))
        .foregroundStyle(Color.white.opacity(0.7))
        .transition(.opacity)
    }

    // MARK: - A request is waiting: the decision card

    private func expandedCard(_ request: ClinicRequest) -> some View {
        VStack(spacing: 0) {
            expandedHeader
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    urgencyBadge(request)
                    Spacer()
                    Text(request.travelLabel)
                        .font(TimiVetFont.ui(10, weight: .semibold)).foregroundStyle(TimiVetColor.muted)
                }
                Text(request.petLine).font(TimiVetFont.ui(14, weight: .bold)).foregroundStyle(TimiVetColor.ink)
                Text(request.concernSummary)
                    .font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button("Available now") {
                        // The workspace's immediate-accept default, verbatim
                        // (see ConsoleView.decisionWorkspace's onChange):
                        // emergencies go in as emergency intake, everything
                        // else as the standard "available now" offer.
                        store.responseType = request.isEmergency ? "emergency_intake" : "available_now"
                        Task { await store.answer(request, decline: false) }
                    }
                    .buttonStyle(TimiVetPrimaryButtonStyle(color: request.isEmergency ? TimiVetColor.coral : TimiVetColor.blue))
                    .disabled(store.isBusy)
                    Button("Decline") { Task { await store.answer(request, decline: true) } }
                        .buttonStyle(TimiVetQuietButtonStyle())
                        .disabled(store.isBusy)
                }
                HStack {
                    // Still here for the full flow — custom offers, notes,
                    // emergency details — just no longer the only answer.
                    Button("Open decision workspace") {
                        store.select(request)
                        onOpenMain()
                    }
                    .buttonStyle(.plain)
                    .font(TimiVetFont.ui(10, weight: .semibold))
                    .foregroundStyle(TimiVetColor.blueDark)
                    Spacer()
                    if store.pendingRequests.count > 1 {
                        Text("+\(store.pendingRequests.count - 1) more waiting")
                            .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
                    }
                }
                .padding(.top, 2)
            }
            .padding(12)
        }
        .frame(width: 320)
        .background(TimiVetColor.miniCardBackground)
        .clipShape(RoundedRectangle(cornerRadius: TimiVetMetrics.miniRadius))
        // `navy`, not `ink`: the mockup's floating-panel border tone — see
        // Theme.swift.
        .overlay(RoundedRectangle(cornerRadius: TimiVetMetrics.miniRadius).stroke(TimiVetColor.navy, lineWidth: 2))
    }

    private var expandedHeader: some View {
        HStack(spacing: 8) {
            HStack(alignment: .lastTextBaseline, spacing: 2) {
                Text("Tími").font(TimiVetFont.display(16)).foregroundStyle(.white)
                Text(" NOW").font(TimiVetFont.ui(8, weight: .bold)).foregroundStyle(TimiVetColor.coral)
            }
            Circle().fill(statusColor).frame(width: 6, height: 6)
            Spacer()
            if isHovering { hoverControls }
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(TimiVetColor.navy)
    }

    private func urgencyBadge(_ request: ClinicRequest) -> some View {
        Text(request.isEmergency ? "EMERGENCY" : request.urgency.replacingOccurrences(of: "_", with: " ").uppercased())
            .font(TimiVetFont.ui(9, weight: .bold))
            .foregroundStyle(request.isEmergency ? TimiVetColor.coralDark : TimiVetColor.blueDark)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(request.isEmergency ? TimiVetColor.coralSoft : TimiVetColor.blueSoft, in: Capsule())
    }
}

/// Measured size of whichever state the pill is in, reported up to the host
/// panel so the window can follow the content instead of clipping it.
private struct MiniConsoleSizeKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}
