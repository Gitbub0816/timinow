import Foundation
import SwiftUI

/// Draws a component's element tree.
///
/// Two rules the previous version broke:
///
/// Nothing is clipped. A component whose contents do not fit should *look*
/// wrong — overflowing, overlapping — rather than being silently cut through
/// the middle of a word, which reads as a rendering bug rather than as a
/// layout that needs fixing.
///
/// Text shrinks before it truncates and truncates before it clips, so a label
/// in a frame slightly too small stays readable and a label in a frame far too
/// small ends in an ellipsis instead of a sliced glyph.
public struct LabElementView: View {
    public var element: LabElement
    /// Replaces the first text node encountered, for per-instance copy.
    public var textOverride: String

    public init(element: LabElement, textOverride: String = "") {
        self.element = element
        self.textOverride = textOverride
    }

    public var body: some View {
        content
            .padding(.top, element.style.padding.top)
            .padding(.leading, element.style.padding.leading)
            .padding(.bottom, element.style.padding.bottom)
            .padding(.trailing, element.style.padding.trailing)
            .modifier(LabBoxDecoration(style: element.style))
            .modifier(LabSizing(style: element.style))
            .rotationEffect(.degrees(element.style.rotation))
            .opacity(element.style.opacity)
    }

    @ViewBuilder private var content: some View {
        switch element.kind {
        case .stack:      stack
        case .box:        stack          // a box with children lays them out the same way
        case .text:       textView
        case .glyph:      glyphView
        case .spacer:     Spacer(minLength: 0)
        case .divider:    Rectangle().fill(LabColor.resolve(element.style.stroke.token == "none"
                                                            ? LabPaint.ink : element.style.stroke))
        case .dot:        Circle().fill(LabColor.resolve(element.style.fill))
        case .capsuleBar: Capsule().fill(LabColor.resolve(element.style.fill))
        }
    }

    @ViewBuilder private var stack: some View {
        if element.children.isEmpty {
            // An empty box still needs to occupy its frame, or a decorated
            // container collapses to nothing and looks like it failed.
            Color.clear
        } else {
            switch element.style.axis {
            case "v":
                VStack(alignment: horizontalAlignment, spacing: element.style.spacing) {
                    ForEach(element.children) { child in
                        LabElementView(element: child, textOverride: textOverride)
                    }
                }
            case "z":
                ZStack {
                    ForEach(element.children) { child in
                        LabElementView(element: child, textOverride: textOverride)
                    }
                }
            default:
                HStack(alignment: verticalAlignment, spacing: element.style.spacing) {
                    ForEach(element.children) { child in
                        LabElementView(element: child, textOverride: textOverride)
                    }
                }
            }
        }
    }

    private var textView: some View {
        let shown = textOverride.isEmpty ? element.text : textOverride
        return Text(shown)
            .font(.system(size: element.style.fontSize,
                          weight: LabFont.weight(element.style.fontWeight),
                          design: element.style.serif ? .serif : .default))
            .tracking(element.style.tracking)
            .foregroundStyle(LabColor.resolve(element.style.textColor))
            .lineLimit(element.style.lineLimit == 0 ? nil : element.style.lineLimit)
            .minimumScaleFactor(element.style.minimumScale)
            .multilineTextAlignment(element.style.alignment == "trailing" ? .trailing
                                    : element.style.alignment == "leading" ? .leading : .center)
            .fixedSize(horizontal: false, vertical: element.style.lineLimit == 0)
    }

    private var glyphView: some View {
        Image(systemName: element.symbol)
            .font(.system(size: element.style.fontSize,
                          weight: LabFont.weight(element.style.fontWeight)))
            .foregroundStyle(LabColor.resolve(element.style.textColor))
    }

    private var horizontalAlignment: HorizontalAlignment {
        switch element.style.alignment {
        case "leading": return .leading
        case "trailing": return .trailing
        default: return .center
        }
    }

    private var verticalAlignment: VerticalAlignment {
        switch element.style.alignment {
        case "leading": return .top
        case "trailing": return .bottom
        default: return .center
        }
    }
}

enum LabFont {
    static func weight(_ step: Int) -> Font.Weight {
        switch max(1, min(9, step)) {
        case 1: return .ultraLight
        case 2: return .thin
        case 3: return .light
        case 4: return .regular
        case 5: return .medium
        case 6: return .semibold
        case 7: return .bold
        case 8: return .heavy
        default: return .black
        }
    }

    static let names = ["Ultra", "Thin", "Light", "Regular", "Medium",
                        "Semibold", "Bold", "Heavy", "Black"]
}

/// Fill, border and the house drop shadow: hard offset, zero blur.
struct LabBoxDecoration: ViewModifier {
    var style: LabStyle

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: style.cornerRadius)
        return content
            .background(
                ZStack {
                    if style.shadowOffset > 0 {
                        shape.fill(LabColor.resolve(style.shadow).opacity(0.92))
                            .offset(x: style.shadowOffset, y: style.shadowOffset)
                    }
                    shape.fill(LabColor.resolve(style.fill))
                }
            )
            .overlay(
                Group {
                    if style.strokeWidth > 0 {
                        shape.stroke(LabColor.resolve(style.stroke), lineWidth: style.strokeWidth)
                    }
                }
            )
    }
}

/// Fixed sizes when given, otherwise grow along the parent's axis if asked.
struct LabSizing: ViewModifier {
    var style: LabStyle

    func body(content: Content) -> some View {
        content
            .frame(width: style.fixedWidth, height: style.fixedHeight)
            .frame(maxWidth: style.grow && style.fixedWidth == nil ? .infinity : nil,
                   maxHeight: style.grow && style.fixedHeight == nil ? .infinity : nil)
    }
}

/// One placed component, drawn at its instance frame.
public struct LabInstanceView: View {
    public var component: LabComponent
    public var instance: LabInstance

    public init(component: LabComponent, instance: LabInstance) {
        self.component = component
        self.instance = instance
    }

    public var body: some View {
        Group {
            if instance.scaleToFit {
                // Lay out at the component's own size and scale the result, so
                // proportions survive a frame that is the wrong shape.
                LabElementView(element: component.root, textOverride: instance.overrideText)
                    .frame(width: component.defaultWidth, height: component.defaultHeight)
                    .scaleEffect(min(instance.width / max(component.defaultWidth, 1),
                                     instance.height / max(component.defaultHeight, 1)))
                    .frame(width: instance.width, height: instance.height)
            } else {
                LabElementView(element: component.root, textOverride: instance.overrideText)
                    .frame(width: instance.width, height: instance.height)
            }
        }
        .rotationEffect(.degrees(instance.rotation))
    }
}
