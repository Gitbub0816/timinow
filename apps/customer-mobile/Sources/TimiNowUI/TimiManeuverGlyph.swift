#if !SKIP && !os(Android)
import SwiftUI

// Tími's maneuver symbols. One drawing system for the banner glyph, the
// "then" chip, and lane guidance, so every arrow in the navigation screen
// shares the same geometry.
//
// The proportions are the design, and they are the road's, not ours. A
// guidance arrow is read in under a second, at arm's length, in daylight, by
// someone who is also driving — so it is built like a road sign: a heavy
// shaft, a head clearly wider than the shaft, one generous corner radius
// reused everywhere, and the whole figure filling its box. The first version
// of this file drew a 13-unit shaft with a small-radius corner, which at
// banner size read as a thin hooked line — closer to the typographic "↰"
// than to a sign — and that is exactly what "cheap" looks like.
//
// Everything is drawn in a 100×100 design space and scaled to whatever frame
// the caller gives it, so one set of numbers governs a 20pt lane arrow and a
// 58pt banner glyph identically. The brand lives in the weight, the rounding
// and the palette around these shapes — never in the direction they point,
// which belongs to the driver.
//
// Coverage: every `TimiManeuverKind`, which is the flattened OSRM/Mapbox
// maneuver vocabulary (type × modifier). The combinatorial cases are covered
// by composition rather than by drawing each one — roundabout exits by
// rotating the exit arm through `roundaboutExitDegrees` (any angle, not a
// fixed set), and lane guidance by stacking several arrows per lane in
// `TimiLaneGlyph`. That is what keeps a finite set of shapes able to draw the
// unbounded set of real maneuvers.

/// The stroked-shaft-plus-arrowhead path for one maneuver, in a 100×100
/// space. `Shape` so it can be `.fill`ed in any color the surface needs.
struct TimiManeuverShape: Shape {
    var kind: TimiManeuverKind
    /// Roundabout exit heading in degrees clockwise from entry; 180 (straight
    /// through) when unknown.
    var roundaboutExitDegrees: Double = 180

    // The proportion system. Every shape below is built from these four
    // numbers, which is what makes a fork and a U-turn look like members of
    // one family rather than two drawings that happen to share a color.
    /// Shaft thickness.
    private static let shaft: CGFloat = 19
    /// Corner radius wherever a shaft changes direction.
    private static let corner: CGFloat = 17
    /// Arrowhead length along the direction of travel.
    private static let headLength: CGFloat = 33
    /// Half the arrowhead's width across it. Comfortably wider than the shaft
    /// — an arrowhead the width of its own shaft stops reading as an arrow.
    private static let headHalfWidth: CGFloat = 23.5

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 100
        let stroke = StrokeStyle(lineWidth: Self.shaft, lineCap: .round, lineJoin: .round)
        let thin = StrokeStyle(lineWidth: Self.shaft * 0.58, lineCap: .round, lineJoin: .round)
        var path = Path()

        func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }

        /// Mirrors an x coordinate across the vertical centerline, for the
        /// right-handed variant of a left-handed drawing.
        func m(_ x: Double, _ mirrored: Bool) -> Double { mirrored ? 100 - x : x }

        /// Filled triangular head. `angle` is the direction of travel in
        /// degrees, 0 pointing up, positive clockwise.
        func head(at tip: CGPoint, angle: Double) -> Path {
            var head = Path()
            let radians = (angle - 90) * .pi / 180
            let direction = CGVector(dx: cos(radians), dy: sin(radians))
            let side = CGVector(dx: -direction.dy, dy: direction.dx)
            let back = CGPoint(
                x: tip.x - direction.dx * Self.headLength,
                y: tip.y - direction.dy * Self.headLength
            )
            head.move(to: tip)
            head.addLine(to: CGPoint(x: back.x + side.dx * Self.headHalfWidth, y: back.y + side.dy * Self.headHalfWidth))
            head.addLine(to: CGPoint(x: back.x - side.dx * Self.headHalfWidth, y: back.y - side.dy * Self.headHalfWidth))
            head.closeSubpath()
            return head
        }

        /// A shaft plus its head: build the centre line, stroke it, and union
        /// the arrowhead on the end.
        func shaft(_ build: (inout Path) -> Void, tip: CGPoint, angle: Double) {
            var line = Path()
            build(&line)
            path.addPath(line.strokedPath(stroke))
            path.addPath(head(at: tip, angle: angle))
        }

        /// An unheaded shaft — the road not taken in a fork, the through lane
        /// past an exit. Lighter so the taken branch wins the glance.
        func ghost(_ build: (inout Path) -> Void) {
            var line = Path()
            build(&line)
            path.addPath(line.strokedPath(thin))
        }

        switch kind {
        case .depart, .straight:
            shaft({ $0.move(to: p(50, 92)); $0.addLine(to: p(50, 46)) }, tip: p(50, 13), angle: 0)

        case .slightLeft, .slightRight:
            let r = kind == .slightRight
            shaft({
                $0.move(to: p(m(58, r), 92))
                $0.addArc(tangent1End: p(m(58, r), 56), tangent2End: p(m(24, r), 26), radius: Self.corner)
                $0.addLine(to: p(m(40, r), 41))
            }, tip: p(m(22, r), 22), angle: r ? 45 : -45)

        case .left, .right:
            // The reference turn. Everything else is a variation on its
            // shaft width, corner radius and head.
            let r = kind == .right
            shaft({
                $0.move(to: p(m(62, r), 92))
                $0.addArc(tangent1End: p(m(62, r), 38), tangent2End: p(m(20, r), 38), radius: Self.corner)
                $0.addLine(to: p(m(44, r), 38))
            }, tip: p(m(16, r), 38), angle: r ? 90 : -90)

        case .sharpLeft, .sharpRight:
            let r = kind == .sharpRight
            shaft({
                $0.move(to: p(m(60, r), 92))
                $0.addArc(tangent1End: p(m(60, r), 36), tangent2End: p(m(26, r), 66), radius: Self.corner)
                $0.addLine(to: p(m(37, r), 56))
            }, tip: p(m(25, r), 67), angle: r ? 140 : -140)

        case .uTurn:
            shaft({
                $0.move(to: p(68, 92))
                $0.addArc(tangent1End: p(68, 34), tangent2End: p(32, 34), radius: 18)
                $0.addArc(tangent1End: p(32, 34), tangent2End: p(32, 74), radius: 18)
                $0.addLine(to: p(32, 56))
            }, tip: p(32, 80), angle: 180)

        case .mergeLeft, .mergeRight:
            // The joining lane bending into the through lane, which continues.
            let r = kind == .mergeRight
            shaft({
                $0.move(to: p(m(72, r), 92))
                $0.addArc(tangent1End: p(m(72, r), 58), tangent2End: p(m(50, r), 40), radius: Self.corner)
                $0.addLine(to: p(m(50, r), 46))
            }, tip: p(m(50, r), 14), angle: 0)
            ghost { $0.move(to: p(m(32, r), 92)); $0.addLine(to: p(m(41, r), 64)) }

        case .forkLeft, .forkRight, .keepLeft, .keepRight:
            // One shaft splitting: the branch taken at full weight, the one
            // declined as a ghost, so the choice is the shape.
            let r = kind == .forkRight || kind == .keepRight
            shaft({
                $0.move(to: p(50, 92))
                $0.addArc(tangent1End: p(50, 56), tangent2End: p(m(24, r), 28), radius: Self.corner)
                $0.addLine(to: p(m(38, r), 42))
            }, tip: p(m(22, r), 24), angle: r ? 42 : -42)
            ghost { $0.move(to: p(50, 62)); $0.addLine(to: p(m(70, r), 38)) }

        case .onRampLeft, .onRampRight:
            // A ramp curves away and climbs; no through lane, because taking
            // the ramp is the whole instruction.
            let r = kind == .onRampRight
            shaft({
                $0.move(to: p(m(34, r), 92))
                $0.addArc(tangent1End: p(m(34, r), 52), tangent2End: p(m(66, r), 30), radius: 26)
                $0.addLine(to: p(m(58, r), 36))
            }, tip: p(m(72, r), 22), angle: r ? 36 : -36)

        case .offRampLeft, .offRampRight:
            // The exit peels off while the road it leaves carries on.
            let r = kind == .offRampRight
            shaft({
                $0.move(to: p(m(44, r), 92))
                $0.addArc(tangent1End: p(m(44, r), 56), tangent2End: p(m(74, r), 30), radius: 24)
                $0.addLine(to: p(m(66, r), 36))
            }, tip: p(m(80, r), 22), angle: r ? 38 : -38)
            ghost { $0.move(to: p(m(42, r), 60)); $0.addLine(to: p(m(42, r), 20)) }

        case .roundabout, .roundaboutLeft, .roundaboutRight, .roundaboutStraight:
            let exit: Double
            switch kind {
            case .roundaboutLeft: exit = 270
            case .roundaboutRight: exit = 90
            case .roundaboutStraight: exit = 180
            default: exit = roundaboutExitDegrees
            }
            let centre = p(50, 46)
            let ring = 23.0
            var circle = Path()
            circle.addEllipse(in: CGRect(x: centre.x - ring, y: centre.y - ring, width: ring * 2, height: ring * 2))
            path.addPath(circle.strokedPath(StrokeStyle(lineWidth: Self.shaft * 0.75)))
            // Entry from the bottom, up to the ring.
            var entry = Path()
            entry.move(to: p(50, 94))
            entry.addLine(to: p(50, centre.y + ring + 3))
            path.addPath(entry.strokedPath(stroke))
            // Exit arm, rotated to the reported heading. 0° would be back the
            // way we came; 180° is straight through.
            let angle = (exit + 90) * .pi / 180
            var arm = Path()
            arm.move(to: CGPoint(x: centre.x + cos(angle) * (ring + 1), y: centre.y + sin(angle) * (ring + 1)))
            arm.addLine(to: CGPoint(x: centre.x + cos(angle) * (ring + 12), y: centre.y + sin(angle) * (ring + 12)))
            path.addPath(arm.strokedPath(stroke))
            path.addPath(head(
                at: CGPoint(x: centre.x + cos(angle) * (ring + 27), y: centre.y + sin(angle) * (ring + 27)),
                angle: exit + 180
            ))

        case .arrive, .arriveLeft, .arriveRight:
            // Arrival is a destination, not a direction: the shaft runs to a
            // ringed point rather than to an arrowhead.
            let offset: Double = kind == .arriveLeft ? -17 : (kind == .arriveRight ? 17 : 0)
            var line = Path()
            line.move(to: p(50, 92))
            line.addLine(to: p(50, 62))
            // A straight bend rather than a tangent arc: the round line join
            // already softens the corner, and at this shallow an angle an
            // arc-to with a 17-unit radius is where the geometry gets fragile.
            line.addLine(to: p(50 + offset, 48))
            path.addPath(line.strokedPath(stroke))
            var pin = Path()
            pin.addEllipse(in: CGRect(x: 50 + offset - 15, y: 10, width: 30, height: 30))
            path.addPath(pin.strokedPath(StrokeStyle(lineWidth: Self.shaft * 0.8)))
        }

        return path.applying(CGAffineTransform(scaleX: scale, y: scale))
    }
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

/// One lane in the lane-guidance row: every arrow painted on that lane, with
/// the one to follow at full strength and the rest receded. Stacking is what
/// lets a finite set of arrows draw the unbounded set of real lane markings.
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
