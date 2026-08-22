import Foundation
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

// Design tokens ported from docs/PLATFORM-CONTRACT.md and
// apps/vet-windows/src/TimiVet/Theme/Theme.xaml. Kept `internal` (no `public`)
// on every type here — the repo's Skip rule keeps SwiftUI implementation
// helpers (colors, button styles, card modifiers) out of the public bridge
// surface, matching apps/customer-mobile/Sources/TimiNowUI/Theme.swift.

enum TimiVetColor {
    // Platform-contract tokens.
    static let ink = Color(hex: 0x111B3B)
    static let inkSoft = Color(hex: 0x3F4862)
    static let paper = Color(hex: 0xFFFAF0)
    static let blue = Color(hex: 0x2357D9)
    static let blueDark = Color(hex: 0x173C9A)
    static let blueSoft = Color(hex: 0xE5ECFF)
    static let coral = Color(hex: 0xF25F4C)
    static let coralDark = Color(hex: 0xBD3E31)
    static let coralSoft = Color(hex: 0xFFE5DF)
    static let gold = Color(hex: 0xF7C84B)
    static let goldSoft = Color(hex: 0xFFF0B9)
    static let canvas = Color(hex: 0xF3F5FA)
    static let line = Color(hex: 0xD9D8D2)
    static let muted = Color(hex: 0x6F7483)
    static let danger = Color(hex: 0xBD3E31)

    // Inline values used throughout Theme.xaml / MainWindow.xaml — the dark
    // left rail, cards, and mini console specifically.
    static let railDeepInk = Color(hex: 0x202B50)
    static let railMutedText = Color(hex: 0xAEB6CB)
    static let railFooterText = Color(hex: 0x8F9AB7)
    static let railDisclaimer = Color(hex: 0x96A0B9)
    static let railFootnote = Color(hex: 0x69738E)
    static let railTag = Color(hex: 0x9DA7C1)
    static let publicCapacityBackground = Color(hex: 0xFFF9E8)
    static let cardBorder = Color(hex: 0xE0E3EA)
    static let cardBorderAlt = Color(hex: 0xE4E6EC)
    static let miniCardBackground = Color(hex: 0xFBFCFF)
    static let miniDivider = Color(hex: 0xE3E6EE)
    static let fieldBorder = Color(hex: 0xCCD1DC)
    static let sectionBorder = Color(hex: 0xD9DCE5)
    static let offerBannerBackground = Color(hex: 0xFFF1ED)
}

enum TimiVetFont {
    /// Georgia for display type; "SF Pro"/system for UI — matching the
    /// contract's Windows/Skip-friendly fallback stacks.
    static func display(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .custom("Georgia", size: size).weight(weight)
    }
    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }
}

enum TimiVetMetrics {
    static let cardRadius: CGFloat = 14
    static let miniRadius: CGFloat = 18
}

extension Color {
    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}

struct TimiVetPrimaryButtonStyle: ButtonStyle {
    var color: Color = TimiVetColor.blue
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(TimiVetFont.ui(14, weight: .semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 38)
            .padding(.horizontal, 15)
            .background(color.opacity(configuration.isPressed ? 0.85 : 1), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(TimiVetColor.ink, lineWidth: 1))
    }
}

struct TimiVetCoralButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        TimiVetPrimaryButtonStyle(color: TimiVetColor.coral).makeBody(configuration: configuration)
    }
}

struct TimiVetQuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(TimiVetFont.ui(14, weight: .semibold))
            .foregroundStyle(TimiVetColor.ink)
            .frame(maxWidth: .infinity, minHeight: 38)
            .padding(.horizontal, 15)
            .background(Color.white.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(TimiVetColor.fieldBorder, lineWidth: 1))
    }
}

extension View {
    func timiVetCard(_ background: Color = .white, radius: CGFloat = TimiVetMetrics.cardRadius) -> some View {
        self
            .padding(18)
            .background(background, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).stroke(TimiVetColor.sectionBorder, lineWidth: 1))
    }

    func timiVetEyebrow() -> some View {
        self.font(TimiVetFont.ui(11, weight: .bold)).foregroundStyle(TimiVetColor.coral)
    }
}
