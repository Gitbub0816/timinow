import Foundation
import SwiftUI

// Design tokens ported from docs/PLATFORM-CONTRACT.md and
// apps/vet-windows/src/TimiVet/Theme/Theme.xaml. Kept `internal` (no `public`)
// on every type here — the repo's Skip rule keeps SwiftUI implementation
// helpers (colors, button styles, card modifiers) out of the public bridge
// surface, matching apps/customer-mobile/Sources/TimiNowUI/Theme.swift.

enum TimiVetColor {
    /// A factory rather than `extension Color { init(hex:) }`.
    ///
    /// Skip cannot merge an initializer into a type declared in another module —
    /// an extension on a foreign type may only add properties and functions — so
    /// the extension form fails the Android transpile with a message that does
    /// not obviously point here. A static function on our own type has no such
    /// restriction and reads the same at the call site.
    static func hex(_ value: UInt32) -> Color {
        Color(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }

    // Platform-contract tokens.
    static let ink = hex(0x111B3B)
    static let inkSoft = hex(0x3F4862)
    static let paper = hex(0xFFFAF0)
    static let blue = hex(0x2357D9)
    static let blueDark = hex(0x173C9A)
    static let blueSoft = hex(0xE5ECFF)
    static let coral = hex(0xF25F4C)
    static let coralDark = hex(0xBD3E31)
    static let coralSoft = hex(0xFFE5DF)
    static let gold = hex(0xF7C84B)
    static let goldSoft = hex(0xFFF0B9)
    static let canvas = hex(0xF3F5FA)
    static let line = hex(0xD9D8D2)
    static let muted = hex(0x6F7483)
    static let danger = hex(0xBD3E31)

    // Inline values used throughout Theme.xaml / MainWindow.xaml — the dark
    // left rail, cards, and mini console specifically.
    static let railDeepInk = hex(0x202B50)
    static let railMutedText = hex(0xAEB6CB)
    static let railFooterText = hex(0x8F9AB7)
    static let railDisclaimer = hex(0x96A0B9)
    static let railFootnote = hex(0x69738E)
    static let railTag = hex(0x9DA7C1)
    static let publicCapacityBackground = hex(0xFFF9E8)
    static let cardBorder = hex(0xE0E3EA)
    static let cardBorderAlt = hex(0xE4E6EC)
    static let miniCardBackground = hex(0xFBFCFF)
    static let miniDivider = hex(0xE3E6EE)
    static let fieldBorder = hex(0xCCD1DC)
    static let sectionBorder = hex(0xD9DCE5)
    static let offerBannerBackground = hex(0xFFF1ED)
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
            .timiVetPress(configuration.isPressed)
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
            .timiVetPress(configuration.isPressed)
    }
}

extension View {
    /// The press itself, given back.
    ///
    /// Both styles changed only their fill opacity, which on a coloured button
    /// against a coloured card is very close to nothing. The work a button
    /// starts happens elsewhere on the screen — a queue row disappears, a
    /// number changes — so with no movement under the pointer there is a
    /// moment where nothing observable has happened, and the reasonable
    /// response to a button that did nothing is to press it again. Twice on
    /// "Send availability offer" is a second offer.
    ///
    /// Two percent and one point down, snapping in and easing out: quick
    /// enough that it reads as the button moving rather than as an animation.
    func timiVetPress(_ pressed: Bool) -> some View {
        scaleEffect(pressed ? 0.97 : 1)
            .offset(y: pressed ? 1 : 0)
            .animation(.spring(response: 0.18, dampingFraction: 0.6), value: pressed)
    }
}

/// Money and dates for the payouts view.
///
/// The formatting is integer arithmetic on purpose. Every amount that reaches
/// this console is already a whole number of cents, and passing one through a
/// Double to divide by 100 is how $30.00 becomes $29.999999 on somebody's
/// screen — a number a practice manager would be entirely right to distrust.
/// `NumberFormatter` is avoided for a second reason: Skip cannot translate its
/// currency configuration, and this file is transpiled for Android.
enum TimiVetMoney {
    static func dollars(_ cents: Int) -> String {
        let negative = cents < 0
        let value = abs(cents)
        let fraction = value % 100
        return "\(negative ? "-" : "")$\(value / 100).\(fraction < 10 ? "0" : "")\(fraction)"
    }

    /// A ledger row's timestamp, short enough to sit beside an amount.
    static func short(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: iso) else { return iso }
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM, h:mm a"
        return formatter.string(from: date)
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
