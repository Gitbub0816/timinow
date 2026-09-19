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

/// The half scroll wheel.
///
/// Three gestures on one control, told apart by where the drag starts rather
/// than by how it moves — which is the only disambiguation a thumb can
/// perform reliably without looking:
///
///   · **Out on the arc** — turn. The angle of your thumb *is* the focused
///     item, absolutely mapped, so one press lands anywhere in the group
///     instead of counting notches past it.
///   · **On the hub, up or down** — change group. Which question is being
///     asked, not which answer.
///   · **Tap the hub** — commit the focused answer.
///
/// Focus is never selection. A thumb resting anywhere on the arc has chosen
/// nothing until the hub is pressed, which is what makes a control this
/// sensitive safe to put in front of somebody booking emergency care.
///
/// The wheel is inset from the trailing edge rather than flush to it: a
/// control hard against the bezel forces the thumb to its extension, which is
/// the expensive direction, and leaves nowhere to rest between turns.
struct DuoWheel: View {
    var navigator: DuoNavigator
    var onCommit: (DuoAction) -> Void

    @Environment(\.accessibilityReduceMotion) var reduceMotion

    // Geometry. The pivot sits inside the control, so the hub is whole and
    // the arc sweeps into the screen rather than off it.
    private let boxWidth: CGFloat = 230
    private let boxHeight: CGFloat = 300
    private let radius: CGFloat = 120
    private let hubRadius: CGFloat = 44
    /// Total sweep. Short of a full half-circle on purpose: the last few
    /// degrees at either end are where a thumb runs out of travel.
    private let sweep: Double = 144

    @State var mode = ""
    /// Where the vertical translation stood when the last group step
    /// fired. `translation` is cumulative from the gesture's start, so a step
    /// has to move the baseline rather than zero a running total.
    @State var groupBaseline: CGFloat = 0

    private var centre: CGPoint { CGPoint(x: boxWidth - hubRadius - 10, y: boxHeight / 2) }

    var body: some View {
        VStack(alignment: .trailing, spacing: 10) {
            groupHeader
            wheel
        }
        .frame(width: boxWidth)
    }

    // MARK: Header

    private var groupHeader: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(navigator.group.label.uppercased())
                .font(.system(size: 11, weight: .black))
                .tracking(1.3)
                .foregroundStyle(TimiColor.muted)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
            // One pip per group, so the vertical dimension has a visible
            // extent. Without it, swiping up and down is a guess about
            // whether there is anything there.
            HStack(spacing: 4) {
                ForEach(Array(navigator.groups.enumerated()), id: \.element.id) { index, _ in
                    Capsule()
                        .fill(index == navigator.groupIndex ? TimiColor.coral : TimiColor.ink.faded(0.25))
                        .frame(width: CGFloat(index == navigator.groupIndex ? 16 : 6), height: 6)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(navigator.group.label). Group \(navigator.groupIndex + 1) of \(navigator.groups.count).")
    }

    // MARK: Wheel

    private var wheel: some View {
        ZStack {
            track
            ForEach(Array(navigator.group.actions.enumerated()), id: \.element.id) { index, action in
                DuoWheelItem(action: action,
                             focused: index == navigator.focusIndex,
                             chosen: navigator.chosen[navigator.group.id] == action.id)
                    .position(point(for: index))
                    .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.78),
                               value: navigator.focusIndex)
            }
            hub
        }
        .frame(width: boxWidth, height: boxHeight)
        .contentShape(Rectangle())
        .gesture(drag)
        // One control to VoiceOver, adjustable, because flicking through
        // sixteen separate dots on an arc is not navigation.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Wheel. \(navigator.group.label)")
        .accessibilityValue(navigator.focused?.label ?? "Nothing")
        .accessibilityHint("Swipe up or down with two fingers to change group. Double tap to choose.")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: navigator.turn(1)
            case .decrement: navigator.turn(-1)
            @unknown default: break
            }
            tick()
        }
    }

    private var track: some View {
        DuoArc(radius: radius, sweep: sweep, centre: centre)
            .stroke(TimiColor.ink.faded(0.12), style: StrokeStyle(lineWidth: 34, lineCap: .round))
            .overlay(
                DuoArc(radius: radius, sweep: sweep, centre: centre)
                    .stroke(TimiColor.ink.faded(0.55), style: StrokeStyle(lineWidth: 2))
            )
            .frame(width: boxWidth, height: boxHeight)
    }

    private var hub: some View {
        Button {
            commit()
        } label: {
            ZStack {
                Circle().fill(navigator.focused == nil ? TimiColor.ink.faded(0.6) : TimiColor.coral)
                Circle().stroke(TimiColor.ink, lineWidth: 3)
                Image(systemName: "checkmark")
                    .font(.system(size: 20, weight: .black))
                    .foregroundStyle(.white)
            }
            .frame(width: hubRadius * 2, height: hubRadius * 2)
        }
        .buttonStyle(.plain)
        .disabled(navigator.focused == nil)
        .position(centre)
        .accessibilityLabel("Choose \(navigator.focused?.label ?? "nothing")")
    }

    // MARK: Geometry

    /// Angle of item `index`, in degrees, where 0 points straight left.
    private func angle(for index: Int) -> Double {
        let count = navigator.group.actions.count
        guard count > 1 else { return 0 }
        let step = sweep / Double(count - 1)
        return -sweep / 2 + Double(index) * step
    }

    private func point(for index: Int) -> CGPoint {
        let theta = angle(for: index) * .pi / 180
        return CGPoint(x: centre.x - radius * cos(theta),
                       y: centre.y + radius * sin(theta))
    }

    /// Which item a touch at `location` is nearest, by angle.
    private func index(at location: CGPoint) -> Int {
        let count = navigator.group.actions.count
        guard count > 1 else { return 0 }
        let theta = atan2(location.y - centre.y, centre.x - location.x) * 180 / .pi
        let step = sweep / Double(count - 1)
        let raw = (theta + sweep / 2) / step
        return max(0, min(count - 1, Int(raw.rounded())))
    }

    // MARK: Gestures

    private var drag: some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                if mode.isEmpty {
                    let dx = value.startLocation.x - centre.x
                    let dy = value.startLocation.y - centre.y
                    // Where it started decides what it is, once, for the whole
                    // gesture — so a turn that strays over the hub does not
                    // suddenly start changing the question.
                    mode = sqrt(dx * dx + dy * dy) <= hubRadius + 12 ? "group" : "turn"
                    groupBaseline = 0
                }

                if mode == "turn" {
                    let next = index(at: value.location)
                    if next != navigator.focusIndex {
                        navigator.focus(next)
                        tick()
                    }
                } else {
                    // 52pt per group: far enough that a turn's vertical wobble
                    // never trips it, close enough for one flick. A long drag
                    // steps repeatedly, which is how you cross several groups
                    // without lifting off.
                    let travelled = value.translation.height - groupBaseline
                    if abs(travelled) >= 52 {
                        navigator.moveGroup(travelled > 0 ? 1 : -1)
                        groupBaseline = value.translation.height
                        tick(strong: true)
                    }
                }
            }
            .onEnded { _ in
                mode = ""
                groupBaseline = 0
            }
    }

    private func commit() {
        guard let action = navigator.commit() else { return }
        tick(strong: true)
        onCommit(action)
    }

    private func tick(strong: Bool = false) {
        #if !SKIP && canImport(UIKit) && os(iOS)
        // The thing that lets somebody drive this without watching it.
        let generator = UIImpactFeedbackGenerator(style: strong ? .medium : .light)
        generator.impactOccurred()
        #endif
    }
}

/// The arc the items sit on. Drawn left-bulging: 0° points at the screen.
struct DuoArc: Shape {
    var radius: CGFloat
    var sweep: Double
    var centre: CGPoint

    func path(in rect: CGRect) -> Path {
        var path = Path()
        // SwiftUI angles run clockwise from three o'clock; the wheel's own
        // zero points left, which is 180°.
        path.addArc(center: centre, radius: radius,
                    startAngle: .degrees(180 - sweep / 2),
                    endAngle: .degrees(180 + sweep / 2),
                    clockwise: false)
        return path
    }
}

/// One item on the arc.
struct DuoWheelItem: View {
    var action: DuoAction
    var focused: Bool
    var chosen: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(focused ? TimiColor.blueSoft : Color.white)
                .overlay(Circle().stroke(focused ? TimiColor.blue : TimiColor.ink,
                                         lineWidth: focused ? 3 : 2))
            Image(systemName: action.symbol)
                .font(.system(size: focused ? 20 : 15, weight: .bold))
                .foregroundStyle(TimiColor.ink)
            if chosen && !focused {
                Circle().fill(TimiColor.green)
                    .frame(width: 10, height: 10)
                    .offset(x: 14, y: -14)
            }
        }
        .frame(width: CGFloat(focused ? 58 : 40), height: CGFloat(focused ? 58 : 40))
    }
}
