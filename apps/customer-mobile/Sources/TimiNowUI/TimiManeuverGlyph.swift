#if !SKIP && !os(Android)
import SwiftUI

// Tími's maneuver symbols. One drawing system for the banner glyph, the
// "then" chip, and lane guidance, so every arrow in the navigation screen
// shares the same geometry: a stroked spine with a filled triangular head,
// round caps and joins, drawn in a 100×100 design space and scaled to
// whatever frame the caller gives it. The shapes themselves keep the
// standardized road-sign geometry a driver already knows — a branded arrow
// nobody can read at 60 mph is not a design, it is a hazard — and the brand
// lives in the stroke weight, the rounding, and the palette around them.

/// The stroked-spine-plus-arrowhead path for one maneuver, in a 100×100
/// space. `Shape` so it can be `.fill`ed in any color the surface needs.
struct TimiManeuverShape: Shape {
    var kind: TimiManeuverKind
    /// Roundabout exit heading in degrees clockwise from entry; 180 (straight
    /// through) when unknown.
    var roundaboutExitDegrees: Double = 180

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 100
        let stroke = StrokeStyle(lineWidth: 13, lineCap: .round, lineJoin: .round)
        var path = Path()

        func spine(_ build: (inout Path) -> Void, head headPoint: CGPoint, angle: Double) {
            var line = Path()
            build(&line)
            path.addPath(line.strokedPath(stroke))
            path.addPath(arrowHead(at: headPoint, angle: angle))
        }

        /// Filled triangular head. `angle` is the direction of travel in
        /// degrees, 0 pointing up, positive clockwise.
        func arrowHead(at tip: CGPoint, angle: Double) -> Path {
            var head = Path()
            let radians = (angle - 90) * .pi / 180
            let length = 30.0, halfWidth = 17.0
            let direction = CGVector(dx: cos(radians), dy: sin(radians))
            let side = CGVector(dx: -direction.dy, dy: direction.dx)
            let back = CGPoint(x: tip.x - direction.dx * length, y: tip.y - direction.dy * length)
            head.move(to: tip)
            head.addLine(to: CGPoint(x: back.x + side.dx * halfWidth, y: back.y + side.dy * halfWidth))
            head.addLine(to: CGPoint(x: back.x - side.dx * halfWidth, y: back.y - side.dy * halfWidth))
            head.closeSubpath()
            return head
        }

        func point(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }

        switch kind {
        case .depart, .straight:
            spine({ $0.move(to: point(50, 88)); $0.addLine(to: point(50, 34)) }, head: point(50, 12), angle: 0)

        case .slightLeft, .slightRight:
            let mirrored = kind == .slightRight
            spine({
                $0.move(to: point(m(50, mirrored), 88))
                $0.addLine(to: point(m(50, mirrored), 60))
                $0.addLine(to: point(m(30, mirrored), 38))
            }, head: point(m(19, mirrored), 26), angle: mirrored ? 42 : -42)

        case .left, .right:
            let mirrored = kind == .right
            spine({
                $0.move(to: point(m(58, mirrored), 88))
                $0.addLine(to: point(m(58, mirrored), 44))
                $0.addQuadCurve(to: point(m(40, mirrored), 30), control: point(m(58, mirrored), 30))
            }, head: point(m(18, mirrored), 30), angle: mirrored ? 90 : -90)

        case .sharpLeft, .sharpRight:
            let mirrored = kind == .sharpRight
            spine({
                $0.move(to: point(m(52, mirrored), 88))
                $0.addLine(to: point(m(52, mirrored), 40))
                $0.addLine(to: point(m(36, mirrored), 58))
            }, head: point(m(24, mirrored), 71), angle: mirrored ? 138 : -138)

        case .uTurn:
            spine({
                $0.move(to: point(64, 88))
                $0.addLine(to: point(64, 42))
                $0.addArc(center: point(50, 42), radius: 14, startAngle: .degrees(0), endAngle: .degrees(180), clockwise: true)
                $0.addLine(to: point(36, 62))
            }, head: point(36, 80), angle: 180)

        case .mergeLeft, .mergeRight:
            let mirrored = kind == .mergeRight
            // The joining lane curving into the through lane.
            spine({
                $0.move(to: point(m(66, mirrored), 88))
                $0.addQuadCurve(to: point(m(46, mirrored), 48), control: point(m(66, mirrored), 62))
                $0.addLine(to: point(m(46, mirrored), 34))
            }, head: point(m(46, mirrored), 12), angle: 0)
            var through = Path()
            through.move(to: point(m(34, mirrored), 88))
            through.addLine(to: point(m(42, mirrored), 62))
            path.addPath(through.strokedPath(StrokeStyle(lineWidth: 9, lineCap: .round)))

        case .forkLeft, .forkRight, .keepLeft, .keepRight:
            let mirrored = kind == .forkRight || kind == .keepRight
            // Taken branch, full weight.
            spine({
                $0.move(to: point(50, 88))
                $0.addLine(to: point(50, 62))
                $0.addLine(to: point(m(32, mirrored), 40))
            }, head: point(m(24, mirrored), 28), angle: mirrored ? 38 : -38)
            // Declined branch, lighter.
            var other = Path()
            other.move(to: point(50, 62))
            other.addLine(to: point(m(64, mirrored), 42))
            path.addPath(other.strokedPath(StrokeStyle(lineWidth: 8, lineCap: .round)))

        case .onRampLeft, .onRampRight:
            let mirrored = kind == .onRampRight
            spine({
                $0.move(to: point(m(38, mirrored), 88))
                $0.addQuadCurve(to: point(m(58, mirrored), 44), control: point(m(38, mirrored), 56))
                $0.addLine(to: point(m(60, mirrored), 34))
            }, head: point(m(62, mirrored), 14), angle: mirrored ? 10 : -10)

        case .offRampLeft, .offRampRight:
            let mirrored = kind == .offRampRight
            spine({
                $0.move(to: point(m(44, mirrored), 88))
                $0.addLine(to: point(m(44, mirrored), 64))
                $0.addQuadCurve(to: point(m(66, mirrored), 34), control: point(m(46, mirrored), 42))
            }, head: point(m(74, mirrored), 22), angle: mirrored ? 32 : -32)
            var through = Path()
            through.move(to: point(m(44, mirrored), 58))
            through.addLine(to: point(m(44, mirrored), 24))
            path.addPath(through.strokedPath(StrokeStyle(lineWidth: 8, lineCap: .round)))

        case .roundabout, .roundaboutLeft, .roundaboutRight, .roundaboutStraight:
            let exit: Double
            switch kind {
            case .roundaboutLeft: exit = 270
            case .roundaboutRight: exit = 90
            case .roundaboutStraight: exit = 180
            default: exit = roundaboutExitDegrees
            }
            let center = point(50, 44)
            let ring = 20.0
            var circle = Path()
            circle.addEllipse(in: CGRect(x: center.x - ring, y: center.y - ring, width: ring * 2, height: ring * 2))
            path.addPath(circle.strokedPath(StrokeStyle(lineWidth: 11)))
            var entry = Path()
            entry.move(to: point(50, 90))
            entry.addLine(to: point(50, 44 + ring + 4))
            path.addPath(entry.strokedPath(stroke))
            // Exit arm: from the ring edge outward at the exit heading.
            // 0° = back the way we came (u-turn), 180° = straight through.
            let exitAngle = (exit + 90) * .pi / 180
            let from = CGPoint(x: center.x + cos(exitAngle) * (ring + 2), y: center.y + sin(exitAngle) * (ring + 2))
            let to = CGPoint(x: center.x + cos(exitAngle) * (ring + 16), y: center.y + sin(exitAngle) * (ring + 16))
            var arm = Path()
            arm.move(to: from)
            arm.addLine(to: to)
            path.addPath(arm.strokedPath(stroke))
            path.addPath(arrowHead(
                at: CGPoint(x: center.x + cos(exitAngle) * (ring + 28), y: center.y + sin(exitAngle) * (ring + 28)),
                angle: exit + 180
            ))

        case .arrive, .arriveLeft, .arriveRight:
            let xOffset: Double = kind == .arriveLeft ? -14 : (kind == .arriveRight ? 14 : 0)
            spine({ $0.move(to: point(50, 88)); $0.addLine(to: point(50 + xOffset, 52)) },
                  head: point(50 + xOffset, 34), angle: xOffset == 0 ? 0 : (xOffset > 0 ? 21 : -21))
            // The destination dot the arrow points at — Tími's map-pin motif.
            var pin = Path()
            pin.addEllipse(in: CGRect(x: 50 + xOffset - 9, y: 6, width: 18, height: 18))
            path.addPath(pin.strokedPath(StrokeStyle(lineWidth: 9)))
        }

        return path.applying(CGAffineTransform(scaleX: scale, y: scale))
    }

    /// Mirrors an x coordinate across the vertical centerline for the
    /// right-handed variant of a left-handed drawing.
    private func m(_ x: Double, _ mirrored: Bool) -> Double { mirrored ? 100 - x : x }
}

/// The banner/chip glyph: the maneuver shape in a single color, sized by the
/// frame the caller applies. Purely decorative to assistive tech — the
/// banner's text carries the same information.
struct TimiManeuverGlyph: View {
    var kind: TimiManeuverKind
    var roundaboutExitDegrees: Double?
    var color: Color

    var body: some View {
        TimiManeuverShape(kind: kind, roundaboutExitDegrees: roundaboutExitDegrees ?? 180)
            .fill(color)
            .aspectRatio(1, contentMode: .fit)
            .accessibilityHidden(true)
    }
}

/// One lane in the lane-guidance row: every painted arrow in the lane, with
/// the arrow to follow at full strength and the rest receded.
struct TimiLaneGlyph: View {
    var lane: TimiLane
    var activeColor: Color
    var inactiveColor: Color

    var body: some View {
        ZStack {
            ForEach(Array(lane.arrows.enumerated()), id: \.offset) { _, arrow in
                TimiManeuverShape(kind: arrow)
                    .fill(arrow == lane.active ? activeColor : inactiveColor)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}
#endif
