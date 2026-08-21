import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

struct TimiWordmark: View {
    var compact = false
    var body: some View {
        Image("timinow-wordmark", bundle: .module)
            .resizable().scaledToFit().frame(width: compact ? 132 : 194, height: compact ? 46 : 68)
            .accessibilityLabel("Tími NOW")
    }
}

struct CareCompanionArtwork: View {
    var compact = false
    @State private var floating = false

    var body: some View {
        Image("timi-care-companion", bundle: .module)
            .resizable()
            .scaledToFit()
            .frame(maxHeight: compact ? 182 : 310)
            .offset(y: floating ? -6 : 5)
            .rotationEffect(.degrees(floating ? 0.7 : -0.7))
            .shadow(color: TimiColor.blue.opacity(0.18), radius: 18, y: 12)
            .animation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true), value: floating)
            .onAppear { floating = true }
            .accessibilityLabel("A German Shepherd surrounded by live veterinary clinic responses")
    }
}

struct Eyebrow: View {
    var text: String
    var color: Color = TimiColor.coral
    var body: some View { Text(text.uppercased()).font(.system(size: 11, weight: .black)).tracking(1.6).foregroundStyle(color) }
}

struct PulsingBeacon: View {
    @State private var pulse = false
    var symbol = "pawprint.fill"
    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { index in
                Circle().stroke(TimiColor.blue.opacity(0.26 - Double(index) * 0.06), lineWidth: 2)
                    .frame(width: CGFloat(104 + index * 44), height: CGFloat(104 + index * 44))
                    .scaleEffect(pulse ? 1.12 : 0.86).opacity(pulse ? 0.18 : 0.9)
                    .animation(.easeOut(duration: 1.8).repeatForever(autoreverses: false).delay(Double(index) * 0.22), value: pulse)
            }
            Circle().fill(TimiColor.blue).frame(width: 92, height: 92).overlay(Image(systemName: symbol).font(.system(size: 37, weight: .bold)).foregroundStyle(.white))
                .overlay(Circle().stroke(TimiColor.ink, lineWidth: 3)).shadow(color: TimiColor.ink.opacity(0.3), radius: 0, x: 5, y: 6)
        }.frame(height: 230).onAppear { pulse = true }.accessibilityHidden(true)
    }
}

struct ProgressPills: View {
    var current: Int
    var total: Int
    var body: some View {
        HStack(spacing: 7) { ForEach(0..<total, id: \.self) { i in Capsule().fill(i <= current ? TimiColor.coral : TimiColor.ink.opacity(0.12)).frame(width: i == current ? 30 : 8, height: 8).animation(.spring(response: 0.35), value: current) } }
    }
}

struct MetricChip: View {
    var title: String; var value: String; var color: Color = TimiColor.blueSoft
    var body: some View { VStack(alignment: .leading, spacing: 5) { Text(title.uppercased()).font(.system(size: 9, weight: .black)).foregroundStyle(TimiColor.muted); Text(value).font(.system(size: 17, weight: .black)).foregroundStyle(TimiColor.ink) }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(color, in: RoundedRectangle(cornerRadius: 14)) }
}

struct SafetyBanner: View {
    var compact = false
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "cross.case.fill").foregroundStyle(.white).frame(width: 34, height: 34).background(TimiColor.coral, in: Circle())
            VStack(alignment: .leading, spacing: 3) { Text("Possible emergency?").font(.headline); Text(compact ? "Do not wait for an app response." : "If your pet may be in immediate danger, leave for the nearest emergency-capable hospital while someone calls ahead.").font(.caption).foregroundStyle(TimiColor.muted) }
        }.padding(14).background(TimiColor.coralSoft, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(TimiColor.coral.opacity(0.45)))
    }
}

struct ErrorToast: View {
    var message: String
    var dismiss: () -> Void
    var body: some View {
        HStack { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(TimiColor.gold); Text(message).font(.callout).fontWeight(.semibold); Spacer(); Button(action: dismiss) { Image(systemName: "xmark") } }
            .padding().background(TimiColor.ink, in: RoundedRectangle(cornerRadius: 16)).foregroundStyle(.white).padding(.horizontal)
    }
}

struct CelebrationOverlay: View {
    @State private var expand = false
    var body: some View {
        ZStack {
            Color.black.opacity(expand ? 0 : 0.08).ignoresSafeArea()
            ForEach(0..<18, id: \.self) { i in
                Circle().fill(i % 3 == 0 ? TimiColor.coral : (i % 3 == 1 ? TimiColor.gold : TimiColor.blue)).frame(width: 10, height: 10)
                    .offset(x: expand ? CGFloat((i % 6 - 3) * 58) : 0, y: expand ? CGFloat((i / 6 - 1) * 170) : 0).opacity(expand ? 0 : 1)
                    .animation(.easeOut(duration: 1.0).delay(Double(i % 5) * 0.03), value: expand)
            }
            Image(systemName: "checkmark").font(.system(size: 44, weight: .black)).foregroundStyle(.white).frame(width: 94, height: 94).background(TimiColor.blue, in: Circle()).overlay(Circle().stroke(TimiColor.ink, lineWidth: 3)).scaleEffect(expand ? 1.08 : 0.3).animation(.spring(response: 0.46, dampingFraction: 0.58), value: expand)
        }.allowsHitTesting(false).onAppear { expand = true }
    }
}
