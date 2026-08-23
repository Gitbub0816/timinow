import Foundation
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

extension Color {
    /// `opacity`, but the result is unambiguously a `Color`.
    ///
    /// `Color` has three different `opacity(_:)` members reachable on it: its
    /// own, `View`'s, and `ShapeStyle`'s. Passed to something that takes any
    /// `ShapeStyle` — `stroke`, `fill`, `background` — more than one of them
    /// fits, and the compiler reports "ambiguous use of 'opacity'" pointing at
    /// whichever it happened to be looking at. It only surfaces once the
    /// overload set gets crowded enough, so it appears with the Mapbox build
    /// and not without, in a file that has nothing to do with Mapbox.
    ///
    /// A concrete return type ends the argument.
    func faded(_ amount: Double) -> Color { opacity(amount) }
}

enum TimiColor {
    static let ink = Color(red: 0.067, green: 0.106, blue: 0.231)
    static let paper = Color(red: 1.0, green: 0.980, blue: 0.941)
    static let blue = Color(red: 0.137, green: 0.341, blue: 0.851)
    static let blueSoft = Color(red: 0.898, green: 0.925, blue: 1.0)
    static let coral = Color(red: 0.949, green: 0.373, blue: 0.298)
    static let coralSoft = Color(red: 1.0, green: 0.898, blue: 0.875)
    static let gold = Color(red: 0.969, green: 0.784, blue: 0.294)
    static let goldSoft = Color(red: 1.0, green: 0.941, blue: 0.725)
    static let canvas = Color(red: 0.965, green: 0.969, blue: 0.984)
    static let muted = Color(red: 0.435, green: 0.455, blue: 0.514)
}

struct TimiPrimaryButtonStyle: ButtonStyle {
    var color: Color = TimiColor.coral
    init(color: Color = TimiColor.coral) { self.color = color }
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .black))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 54)
            .padding(.horizontal, 18)
            // The shadow is cast by the shape, not by the button. `.shadow` on
            // a view applies to everything it has drawn, the label included,
            // so a hard offset shadow — radius 0 — renders a second copy of
            // the text a few points down and to the right. On the web this is
            // a box-shadow, which is a property of the box; SwiftUI has no
            // such thing, and the direct translation ghosts every label in
            // the app.
            .background(Self.plate(color: color, pressed: configuration.isPressed))
            .offset(y: CGFloat(configuration.isPressed ? 3 : 0))
            .animation(.easeOut(duration: 0.14), value: configuration.isPressed)
    }

    private static func plate(color: Color, pressed: Bool) -> some View {
        let shape = RoundedRectangle(cornerRadius: 17)
        return shape.fill(color.faded(pressed ? 0.82 : 1))
            .overlay(shape.stroke(TimiColor.ink, lineWidth: 2))
            .shadow(color: TimiColor.ink, radius: 0, x: CGFloat(pressed ? 0 : 4), y: CGFloat(pressed ? 0 : 5))
    }
}

struct TimiQuietButtonStyle: ButtonStyle {
    init() { }
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(TimiColor.ink)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(Color.white.faded(configuration.isPressed ? 0.55 : 0.95), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(TimiColor.ink.faded(0.25), lineWidth: 1))
    }
}

extension View {
    /// Text entry in the same hand as the buttons and the cards: a solid
    /// plate, a full-weight ink border, and the same hard offset shadow.
    ///
    /// Every field in the app was a 1pt hairline at 18% ink on white — the
    /// default a form gets when nobody styles it. Next to a coral button with
    /// a 2pt border and a five-point drop, it reads as a different app's
    /// screen bolted onto this one.
    ///
    /// The shadow is on the shape, not the field: `.shadow` on a view applies
    /// to what the view has drawn, which for a text field is the text.
    func timiField() -> some View {
        let shape = RoundedRectangle(cornerRadius: 16)
        return self
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(TimiColor.ink)
            .padding(.horizontal, 16)
            .padding(.vertical, 15)
            .background(
                shape.fill(Color.white)
                    .overlay(shape.stroke(TimiColor.ink, lineWidth: 2))
                    .shadow(color: TimiColor.ink.faded(0.9), radius: 0, x: 3, y: 4)
            )
    }

    /// The multi-line version. Same plate, no fixed vertical padding, because
    /// a TextEditor supplies its own and doubling it leaves the caret floating.
    func timiFieldMultiline() -> some View {
        let shape = RoundedRectangle(cornerRadius: 16)
        return self
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(TimiColor.ink)
            .padding(10)
            .background(
                shape.fill(Color.white)
                    .overlay(shape.stroke(TimiColor.ink, lineWidth: 2))
                    .shadow(color: TimiColor.ink.faded(0.9), radius: 0, x: 3, y: 4)
            )
    }

    /// The card's border and drop shadow belong to the card, not to what is
    /// written on it — see TimiPrimaryButtonStyle.plate for why that matters.
    func timiCard(_ color: Color = .white) -> some View {
        let shape = RoundedRectangle(cornerRadius: 24)
        return self.padding(18).background(
            shape.fill(color)
                .overlay(shape.stroke(TimiColor.ink, lineWidth: 2))
                .shadow(color: TimiColor.ink.faded(0.95), radius: 0, x: 5, y: 6)
        )
    }
}

enum TimiFormat {
    static func money(_ cents: Int?) -> String {
        guard let cents, cents > 0 else { return "None" }
        return String(format: "$%.0f", Double(cents) / 100)
    }
    static func wait(_ min: Int?, _ max: Int?) -> String {
        if min == nil && max == nil { return "Not supplied" }
        if min == max { return "\(min ?? 0) min" }
        return "\(min ?? 0)–\(max ?? 0) min"
    }
}
