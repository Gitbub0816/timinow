import SwiftUI

/// Complication/widget-free MVP: active care-search status, the chosen
/// clinic, ETA and next maneuver mirrored from the phone, and the arrival
/// milestone buttons — all driven by `WatchSessionBridge`.
struct WatchContentView: View {
    var bridge = WatchSessionBridge.shared

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text(headline).font(.headline)
                    if let address = bridge.clinicAddress {
                        Text(address).font(.caption2).foregroundStyle(.secondary)
                    }
                    if let eta = bridge.etaMinutes {
                        Label("\(eta) min", systemImage: "clock.fill").font(.subheadline)
                    }
                    if let instruction = bridge.nextInstruction {
                        Label(instruction, systemImage: "arrow.triangle.turn.up.right.diamond.fill")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let note = bridge.clinicNote {
                        Text(note).font(.caption2).foregroundStyle(.secondary)
                    }
                    Divider()
                    milestoneButton("I'm here", "arrived")
                    milestoneButton("Triaged", "triaged")
                    milestoneButton("Seen", "seen")
                }
                .padding(.horizontal, 4)
            }
            .navigationTitle("Tími")
        }
    }

    var headline: String {
        if let clinicName = bridge.clinicName { return clinicName }
        switch bridge.searchStatus {
        case "collecting", "offers_ready": return "Searching for \(bridge.petName)"
        default: return "Tími NOW"
        }
    }

    func milestoneButton(_ title: String, _ milestone: String) -> some View {
        Button(title) { bridge.sendMilestone(milestone) }
            .buttonStyle(.borderedProminent)
    }
}
