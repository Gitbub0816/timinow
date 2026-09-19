import SwiftUI

/// Tími's tokens, copied rather than imported — see Package.swift for why.
///
/// Values come from CLAUDE.md section 7 and Sources/TimiNowUI/Theme.swift.
/// Keep them in step by hand if the product palette moves.
public enum LabColor {
    public static let ink       = Color(red: 0.067, green: 0.106, blue: 0.231)
    public static let paper     = Color(red: 1.000, green: 0.980, blue: 0.941)
    public static let canvas    = Color(red: 0.965, green: 0.969, blue: 0.984)
    public static let blue      = Color(red: 0.137, green: 0.341, blue: 0.851)
    public static let blueSoft  = Color(red: 0.898, green: 0.925, blue: 1.000)
    public static let coral     = Color(red: 0.949, green: 0.373, blue: 0.298)
    public static let coralSoft = Color(red: 1.000, green: 0.898, blue: 0.875)
    public static let gold      = Color(red: 0.969, green: 0.784, blue: 0.294)
    public static let goldSoft  = Color(red: 1.000, green: 0.941, blue: 0.725)
    public static let green     = Color(red: 0.071, green: 0.518, blue: 0.365)
    public static let greenSoft = Color(red: 0.863, green: 0.941, blue: 0.906)
    /// Chosen because it clears 4.5:1 on every light background in use.
    public static let muted     = Color(red: 0.357, green: 0.376, blue: 0.447)
}

/// The signature treatment: 2px ink border, hard offset shadow, no blur.
public struct LabCard: ViewModifier {
    var fill: Color = .white
    var radius: CGFloat = 16
    var offset: CGFloat = 4
    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius)
        return content.background(
            shape.fill(fill)
                .overlay(shape.stroke(LabColor.ink, lineWidth: 2))
                .shadow(color: LabColor.ink.opacity(0.9), radius: 0, x: offset, y: offset)
        )
    }
}

public extension View {
    func labCard(_ fill: Color = .white, radius: CGFloat = 16, offset: CGFloat = 4) -> some View {
        modifier(LabCard(fill: fill, radius: radius, offset: offset))
    }
    /// A flat panel with no shadow — for chrome that sits behind content.
    func labPanel(_ fill: Color = LabColor.paper, radius: CGFloat = 14) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius)
        return background(shape.fill(fill).overlay(shape.stroke(LabColor.ink, lineWidth: 2)))
    }
}

public extension LabColor {
    /// Resolve a paint to a colour. Unknown tokens fall back to ink rather
    /// than to clear, so a typo shows up as a visible black box instead of a
    /// component that silently disappeared.
    static func resolve(_ paint: LabPaint) -> Color {
        switch paint.token {
        case "none":      return .clear
        case "ink":       return ink
        case "paper":     return paper
        case "canvas":    return canvas
        case "white":     return .white
        case "coral":     return coral
        case "coralSoft": return coralSoft
        case "blue":      return blue
        case "blueSoft":  return blueSoft
        case "gold":      return gold
        case "goldSoft":  return goldSoft
        case "green":     return green
        case "greenSoft": return greenSoft
        case "muted":     return muted
        case "custom":    return fromHex(paint.hex)
        default:          return ink
        }
    }

    static func fromHex(_ hex: String) -> Color {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = Int(s, radix: 16) else { return ink }
        return Color(red: Double((value >> 16) & 0xFF) / 255,
                     green: Double((value >> 8) & 0xFF) / 255,
                     blue: Double(value & 0xFF) / 255)
    }
}
