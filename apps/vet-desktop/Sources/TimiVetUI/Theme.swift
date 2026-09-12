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

    // Platform-contract tokens, retuned to the clinic owner's mockup palette
    // (see the Artifact skill session that produced apps/vet-desktop's
    // reskin: navy #101b3d, ink #242323, coral #f65f50, blue #2d5bd7, page
    // #f3f5fb) while keeping every existing token *name* stable — nothing
    // that reads `TimiVetColor.blue` needed to change, only what `blue` is.
    static let ink = hex(0x242323)
    static let inkSoft = hex(0x3F4862)
    static let paper = hex(0xFFFAF0)
    static let blue = hex(0x2D5BD7)
    static let blueDark = hex(0x2449AC)
    static let blueSoft = hex(0xE8EFFF)
    static let coral = hex(0xF65F50)
    static let coralDark = hex(0xBD3E31)
    static let coralSoft = hex(0xFFF0ED)
    static let gold = hex(0xF7C84B)
    static let goldSoft = hex(0xFFF0B9)
    static let canvas = hex(0xF3F5FB)
    static let line = hex(0xD7DCE7)
    // #575D71 — darkened from #6D7487 to clear WCAG 1.4.3's 4.5:1 minimum.
    static let muted = hex(0x575D71)
    static let danger = hex(0xBD3E31)
    /// The mockup's `--green`/`--green-soft` — status pills ("Active",
    /// "Published", "On the way") and the connection dot.
    static let green = hex(0x12845D)
    static let greenSoft = hex(0xE9F7F1)
    /// The mockup's `--navy`, i.e. the sidebar/rail background specifically.
    /// Kept distinct from `ink` (now a *text* tone) so retuning body text
    /// never also retunes the sidebar, and vice versa.
    static let navy = hex(0x101B3D)

    // Inline values used throughout Theme.xaml / MainWindow.xaml — the dark
    // left rail, cards, and mini console specifically.
    static let railDeepInk = hex(0x202B50)
    static let railMutedText = hex(0xAEB6CB)
    static let railFooterText = hex(0x8F9AB7)
    static let railDisclaimer = hex(0x96A0B9)
    static let railFootnote = hex(0x69738E)
    static let railTag = hex(0x9DA7C1)
    static let publicCapacityBackground = hex(0xFFF8E8)
    static let cardBorder = hex(0xD7DCE7)
    static let cardBorderAlt = hex(0xE4E6EC)
    static let miniCardBackground = hex(0xFBFCFF)
    static let miniDivider = hex(0xE3E6EE)
    static let fieldBorder = hex(0xCCD1DC)
    static let sectionBorder = hex(0xD7DCE7)
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
    static let cardRadius: CGFloat = 16
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
            // No dark outline: the mockup's `.button.primary` sets its
            // border-color to the same blue as its fill, i.e. no visible
            // ring. A high-contrast ink stroke around a colour-filled action
            // button was this app's older look; the flatter filled button
            // reads closer to the clinic owner's target language.
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
        // 0.97 was written first and it was true but invisible: three percent
        // of a 38-point button is one point, and feedback nobody can see is
        // feedback that does not exist. Four percent, a point of travel and a
        // brightness dip together read as the button physically giving way,
        // which is the entire job.
        scaleEffect(pressed ? 0.96 : 1)
            .offset(y: pressed ? 1 : 0)
            .brightness(pressed ? -0.06 : 0)
            .animation(.spring(response: 0.16, dampingFraction: 0.65), value: pressed)
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
