import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif
#if !SKIP && canImport(UIKit)
import UIKit
#endif

/// Falls back to type when the bundled artwork is missing.
///
/// `Image(_:bundle:)` renders an empty view for a name it cannot resolve, so a
/// resource that fails to make it into the app is a silent hole in the layout
/// rather than an error — which is exactly how it presented: a blank top-left
/// corner on the home screen with nothing to search for. Drawing the wordmark
/// as text instead means the app always reads as Tími.
struct TimiWordmark: View {
    var compact = false

    var body: some View {
        #if !SKIP && canImport(UIKit)
        if let artwork = UIImage(named: "timinow-wordmark", in: .module, with: nil) {
            Image(uiImage: artwork)
                .resizable().scaledToFit()
                .frame(width: CGFloat(compact ? 132 : 194), height: CGFloat(compact ? 46 : 68))
                .accessibilityLabel("Tími NOW")
        } else {
            lettering
        }
        #else
        Image("timinow-wordmark", bundle: .module)
            .resizable().scaledToFit()
            .frame(width: CGFloat(compact ? 132 : 194), height: CGFloat(compact ? 46 : 68))
            .accessibilityLabel("Tími NOW")
        #endif
    }

    private var lettering: some View {
        HStack(spacing: 4) {
            Text("Tími")
                .font(.system(size: CGFloat(compact ? 27 : 40), weight: .bold, design: .serif))
                .foregroundStyle(TimiColor.ink)
            Text("NOW")
                .font(.system(size: CGFloat(compact ? 12 : 17), weight: .black))
                .tracking(1.2)
                .foregroundStyle(.white)
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(TimiColor.coral, in: RoundedRectangle(cornerRadius: 6))
        }
        .accessibilityElement()
        .accessibilityLabel("Tími NOW")
    }
}

/// What happens when you tap the button, in one panel.
///
/// This replaces a decorative card that showed a floating illustration beside
/// the words "Live intake near you" — which said nothing, and rendered as an
/// empty blue rectangle whenever the illustration failed to load. The numbers
/// here are the actual product promise, and they need no artwork to survive.
struct CareLaunchPanel: View {
    var petName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 11) {
                ZStack {
                    Circle().fill(TimiColor.blue).frame(width: 42, height: 42)
                    Image(systemName: "wave.3.right")
                        .font(.system(size: 17, weight: .black)).foregroundStyle(.white)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("One intake, many answers")
                        .font(.system(size: 17, weight: .black)).foregroundStyle(TimiColor.ink)
                    Text("Nothing is booked for \(petName) until you choose.")
                        .font(.caption).foregroundStyle(TimiColor.muted)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                step("30", "asked", TimiColor.blueSoft)
                chevron
                step("5", "answer", TimiColor.goldSoft)
                chevron
                step("1", "you pick", TimiColor.coralSoft)
            }
        }
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 11, weight: .black)).foregroundStyle(TimiColor.muted)
    }

    private func step(_ value: String, _ label: String, _ tint: Color) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.system(size: 22, weight: .bold, design: .serif)).foregroundStyle(TimiColor.ink)
            Text(label).font(.system(size: 10, weight: .black)).tracking(0.6).foregroundStyle(TimiColor.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 11)
        .background(tint, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct CareCompanionArtwork: View {
    var compact = false
    @State var floating = false

    var body: some View {
        Image("timi-care-companion", bundle: .module)
            .resizable()
            .scaledToFit()
            .frame(maxHeight: CGFloat(compact ? 182 : 310))
            .offset(y: CGFloat(floating ? -6 : 5))
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
    @State var pulse = false
    var symbol = "pawprint.fill"
    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { index in
                Circle().stroke(TimiColor.blue.faded(0.26 - Double(index) * 0.06), lineWidth: 2)
                    .frame(width: CGFloat(104 + index * 44), height: CGFloat(104 + index * 44))
                    .scaleEffect(CGFloat(pulse ? 1.12 : 0.86)).opacity(Double(pulse ? 0.18 : 0.9))
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
        HStack(spacing: 7) { ForEach(0..<total, id: \.self) { i in Capsule().fill(i <= current ? TimiColor.coral : TimiColor.ink.faded(0.12)).frame(width: CGFloat(i == current ? 30 : 8), height: 8).animation(.spring(response: 0.35), value: current) } }
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
        }.padding(14).background(TimiColor.coralSoft, in: RoundedRectangle(cornerRadius: 18)).overlay(RoundedRectangle(cornerRadius: 18).stroke(TimiColor.coral.faded(0.45)))
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
    @State var expand = false
    var body: some View {
        ZStack {
            Color.black.faded(Double(expand ? 0 : 0.08)).ignoresSafeArea()
            ForEach(0..<18, id: \.self) { i in
                Circle().fill(i % 3 == 0 ? TimiColor.coral : (i % 3 == 1 ? TimiColor.gold : TimiColor.blue)).frame(width: 10, height: 10)
                    .offset(x: CGFloat(expand ? (i % 6 - 3) * 58 : 0), y: CGFloat(expand ? (i / 6 - 1) * 170 : 0)).opacity(Double(expand ? 0 : 1))
                    .animation(.easeOut(duration: 1.0).delay(Double(i % 5) * 0.03), value: expand)
            }
            Image(systemName: "checkmark").font(.system(size: 44, weight: .black)).foregroundStyle(.white).frame(width: 94, height: 94).background(TimiColor.blue, in: Circle()).overlay(Circle().stroke(TimiColor.ink, lineWidth: 3)).scaleEffect(CGFloat(expand ? 1.08 : 0.3)).animation(.spring(response: 0.46, dampingFraction: 0.58), value: expand)
        }.allowsHitTesting(false).onAppear { expand = true }
    }
}
