#if !SKIP && !os(Android)
import Foundation
import SwiftUI

// The navigation asset system, rendered.
//
// `assets/navigation/**.svg` is the source of truth — the designer's files,
// unmodified except for having their C2PA metadata stripped.
// `scripts/import-nav-assets.mjs` resolves each one down to absolute
// move/line/curve/close commands (relative forms, H/V/S/T shorthand, elliptical
// arcs and `marker-end` arrowheads are all flattened at build time) and writes
// `Resources/nav-assets.json`. This file replays that.
//
// The design system's contract is kept intact: geometry only, painted in
// `currentColor`, so a state is a tint and never a second file. Primitives that
// declare their own colours — the course indicator's cream disc and navy
// keyline — keep them; everything else takes the tint the caller passes.

/// One drawing command, already absolute.
enum TimiNavCommand: Equatable, Sendable {
    case move(CGPoint)
    case line(CGPoint)
    case quad(CGPoint, CGPoint)
    case curve(CGPoint, CGPoint, CGPoint)
    case close
}

/// One painted layer of a primitive: a filled region, or a stroked centre line
/// with the cap/join the asset asked for.
struct TimiNavLayer: Sendable {
    enum Paint: Equatable, Sendable {
        case fill
        case stroke(width: CGFloat, round: Bool)
    }

    var commands: [TimiNavCommand]
    var paint: Paint
    /// nil means `currentColor` — the caller's tint.
    var color: Color?
    var opacity: Double
}

/// A primitive: its drawing box and the layers that make it up, in paint order.
struct TimiNavPrimitive: Sendable {
    var box: CGRect
    var layers: [TimiNavLayer]
}

/// Loads and caches the generated primitives.
enum TimiNavArt {
    private static let primitives: [String: TimiNavPrimitive] = load()

    static func primitive(_ name: String) -> TimiNavPrimitive? { primitives[name] }

    /// Whether the bundled asset set actually contains this primitive. Used by
    /// the glyph layer to fall back rather than draw nothing.
    static func has(_ name: String) -> Bool { primitives[name] != nil }

    static var count: Int { primitives.count }

    private static func load() -> [String: TimiNavPrimitive] {
        guard let url = Bundle.module.url(forResource: "nav-assets", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let assets = root["assets"] as? [String: Any]
        else { return [:] }

        var out: [String: TimiNavPrimitive] = [:]
        for (name, value) in assets {
            guard let entry = value as? [String: Any],
                  let box = entry["box"] as? [Double], box.count == 4,
                  let shapes = entry["shapes"] as? [[String: Any]]
            else { continue }

            var layers: [TimiNavLayer] = []
            for shape in shapes {
                guard let raw = shape["commands"] as? [[Any]] else { continue }
                let commands = decode(raw)
                guard !commands.isEmpty else { continue }

                let paint: TimiNavLayer.Paint
                if (shape["type"] as? String) == "stroke" {
                    let width = (shape["width"] as? Double) ?? 1
                    let round = (shape["cap"] as? String) == "round"
                    paint = .stroke(width: CGFloat(width), round: round)
                } else {
                    paint = .fill
                }

                layers.append(TimiNavLayer(
                    commands: commands,
                    paint: paint,
                    color: color(from: shape["color"] as? String),
                    opacity: (shape["opacity"] as? Double) ?? 1
                ))
            }
            out[name] = TimiNavPrimitive(
                box: CGRect(x: box[0], y: box[1], width: box[2], height: box[3]),
                layers: layers
            )
        }
        return out
    }

    private static func decode(_ raw: [[Any]]) -> [TimiNavCommand] {
        var out: [TimiNavCommand] = []
        for entry in raw {
            guard let kind = entry.first as? String else { continue }
            let numbers = entry.dropFirst().compactMap { $0 as? Double }
            func point(_ index: Int) -> CGPoint? {
                guard numbers.count > index + 1 else { return nil }
                let base = numbers.startIndex + index
                return CGPoint(x: numbers[base], y: numbers[base + 1])
            }
            switch kind {
            case "M": if let p = point(0) { out.append(.move(p)) }
            case "L": if let p = point(0) { out.append(.line(p)) }
            case "Q": if let c = point(0), let p = point(2) { out.append(.quad(c, p)) }
            case "C": if let a = point(0), let b = point(2), let p = point(4) { out.append(.curve(a, b, p)) }
            case "Z": out.append(.close)
            default: break
            }
        }
        return out
    }

    /// `currentColor` stays nil so the caller's tint wins; a literal `#RRGGBB`
    /// is the asset insisting on a specific colour and is honoured.
    private static func color(from raw: String?) -> Color? {
        guard let raw, raw.hasPrefix("#"), raw.count == 7 else { return nil }
        let hex = raw.dropFirst()
        guard let value = Int(hex, radix: 16) else { return nil }
        return Color(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

/// One layer of a primitive as a `Shape`.
///
/// Strokes are converted to outlines inside `path(in:)` rather than left to
/// `.stroke()` on the view: the path is scaled to the frame here, and a stroke
/// applied afterwards would use an unscaled width — a 15-unit shaft drawn 15
/// *points* wide on a 20pt lane arrow. Resolving it here keeps one code path
/// and lets every layer simply be filled.
struct TimiNavLayerShape: Shape {
    var layer: TimiNavLayer
    var box: CGRect

    func path(in rect: CGRect) -> Path {
        guard box.width > 0, box.height > 0 else { return Path() }
        let scale = min(rect.width / box.width, rect.height / box.height)
        // Centre the primitive in whatever frame it is given.
        let offsetX = rect.minX + (rect.width - box.width * scale) / 2 - box.minX * scale
        let offsetY = rect.minY + (rect.height - box.height * scale) / 2 - box.minY * scale

        var path = Path()
        for command in layer.commands {
            switch command {
            case .move(let p): path.move(to: p)
            case .line(let p): path.addLine(to: p)
            case .quad(let c, let p): path.addQuadCurve(to: p, control: c)
            case .curve(let a, let b, let p): path.addCurve(to: p, control1: a, control2: b)
            case .close: path.closeSubpath()
            }
        }

        if case .stroke(let width, let round) = layer.paint {
            path = path.strokedPath(StrokeStyle(
                lineWidth: width,
                lineCap: round ? .round : .butt,
                lineJoin: round ? .round : .miter
            ))
        }

        return path.applying(
            CGAffineTransform(scaleX: scale, y: scale).concatenating(
                CGAffineTransform(translationX: offsetX, y: offsetY)
            )
        )
    }
}

/// A navigation primitive, drawn at whatever size the frame gives it.
///
/// Decorative to assistive technology by default — in this app every primitive
/// sits beside text that already says the same thing.
struct TimiNavArtView: View {
    var name: String
    var tint: Color
    /// Drawn for lane arrows that are painted on the road but not the one to
    /// follow; the design system calls for a tint change, never a second file.
    var opacity: Double = 1

    var body: some View {
        if let primitive = TimiNavArt.primitive(name) {
            ZStack {
                ForEach(Array(primitive.layers.enumerated()), id: \.offset) { _, layer in
                    TimiNavLayerShape(layer: layer, box: primitive.box)
                        .fill(layer.color ?? tint)
                        .opacity(layer.opacity)
                }
            }
            .opacity(opacity)
            .accessibilityHidden(true)
        }
    }
}
#endif

#if canImport(UIKit) && os(iOS)
import UIKit

extension TimiNavArt {
    /// Renders a primitive to an image.
    ///
    /// Needed wherever the destination is not a SwiftUI view: the map's course
    /// puck, which MapboxMaps takes as a `UIImage`, and — once the entitlement
    /// lands — `CPManeuver.symbolImage`, which is how the same maneuver
    /// primitives reach CarPlay's own guidance panel.
    ///
    /// Strokes are stroked rather than outlined here; CoreGraphics does that
    /// natively, and the SwiftUI path has to convert only because it scales the
    /// geometry before the stroke is applied.
    static func image(_ name: String, size: CGFloat, tint: UIColor) -> UIImage? {
        guard let primitive = primitive(name), primitive.box.width > 0, primitive.box.height > 0 else { return nil }
        let canvas = CGSize(width: size, height: size)
        return UIGraphicsImageRenderer(size: canvas).image { context in
            let cg = context.cgContext
            let scale = min(canvas.width / primitive.box.width, canvas.height / primitive.box.height)
            cg.translateBy(
                x: (canvas.width - primitive.box.width * scale) / 2,
                y: (canvas.height - primitive.box.height * scale) / 2
            )
            cg.scaleBy(x: scale, y: scale)
            cg.translateBy(x: -primitive.box.minX, y: -primitive.box.minY)

            for layer in primitive.layers {
                let path = CGMutablePath()
                for command in layer.commands {
                    switch command {
                    case .move(let p): path.move(to: p)
                    case .line(let p): path.addLine(to: p)
                    case .quad(let c, let p): path.addQuadCurve(to: p, control: c)
                    case .curve(let a, let b, let p): path.addCurve(to: p, control1: a, control2: b)
                    case .close: path.closeSubpath()
                    }
                }
                cg.saveGState()
                cg.setAlpha(CGFloat(layer.opacity))
                let color = layer.color.map { UIColor($0) } ?? tint
                cg.addPath(path)
                switch layer.paint {
                case .fill:
                    cg.setFillColor(color.cgColor)
                    cg.fillPath()
                case .stroke(let width, let round):
                    cg.setStrokeColor(color.cgColor)
                    cg.setLineWidth(width)
                    cg.setLineCap(round ? .round : .butt)
                    cg.setLineJoin(round ? .round : .miter)
                    cg.strokePath()
                }
                cg.restoreGState()
            }
        }
    }
}
#endif
