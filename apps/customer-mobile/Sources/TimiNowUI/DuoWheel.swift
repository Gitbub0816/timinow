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

/// The half scroll wheel: a diagonal track, three viewer windows, one focus.
///
/// Rebuilt from the drawing. What the first version got wrong was showing the
/// whole group at once as dots on an arc — which made a ten-item group into
/// ten tiny targets and told you nothing about where you were in it. This one
/// is a **viewport**: three windows ride a diagonal track, the middle one is
/// the focus, and the list moves through them. You always see what is coming
/// next and what you just passed, and the focus never moves, so the eye has
/// one place to rest.
///
/// The track runs lower-left to upper-right because that is the diagonal a
/// thumb sweeps when the hand is at the bottom corner — the same reason the
/// whole control is inset from the edge rather than flush to it.
///
/// Three gestures, told apart by where the drag starts:
///   · on the track or the windows — scroll the list through the focus;
///   · on the action button, up or down — change which question is being asked;
///   · tap the action button — commit what is in the focus window.
///
/// A group with one answer gets no wheel at all. There is nothing to scroll,
/// and a wheel that cannot turn is a control that lies about what it does.
struct DuoWheel: View {
    var navigator: DuoNavigator
    var onCommit: (DuoAction) -> Void

    @Environment(\.accessibilityReduceMotion) var reduceMotion

    // Geometry. The pivot is the bottom-trailing corner of the control, so the
    // track sweeps up into the screen and the action button sits inside it.
    private let boxWidth: CGFloat = 300
    private let boxHeight: CGFloat = 330
    private let radius: CGFloat = 196
    /// Degrees between adjacent windows, and therefore one item of travel.
    private let step: Double = 27
    /// Where the focus window sits: up and to the left of the thumb.
    private let focusAngle: Double = 225

    @State var mode = ""
    @State var startAngle: Double = 0
    @State var startIndex = 0
    @State var groupBaseline: CGFloat = 0

    private var pivot: CGPoint { CGPoint(x: boxWidth, y: boxHeight) }
    private var actions: [DuoAction] { navigator.group.actions }
    private var scrollable: Bool { actions.count > 1 }

    var body: some View {
        VStack(alignment: .trailing, spacing: 12) {
            header
            if scrollable { wheel } else { soloAction }
        }
        .frame(width: boxWidth)
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .trailing, spacing: 5) {
            Text(navigator.group.label.uppercased())
                .font(.system(size: 11, weight: .black))
                .tracking(1.3)
                .foregroundStyle(TimiColor.muted)
                .multilineTextAlignment(.trailing)
                .lineLimit(2)
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

    // MARK: The wheel

    private var wheel: some View {
        ZStack {
            track

            // Only the three windows around the focus are drawn. Everything
            // else in the group is off-track, which is the point of a viewport.
            ForEach(-1...1, id: \.self) { slot in
                let index = navigator.focusIndex + slot
                if actions.indices.contains(index) {
                    DuoWindow(action: actions[index],
                              focused: slot == 0,
                              chosen: navigator.chosen[navigator.group.id] == actions[index].id)
                        .position(point(at: focusAngle + Double(slot) * step))
                        .zIndex(slot == 0 ? 1 : 0)
                }
            }
            .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.82),
                       value: navigator.focusIndex)

            actionButton.position(point(at: focusAngle, radius: 92))
        }
        .frame(width: boxWidth, height: boxHeight)
        .contentShape(Rectangle())
        .gesture(drag)
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

    /// One answer: no track, no windows, just the thing to press. A wheel with
    /// nothing to turn would be a control that lies about what it does.
    private var soloAction: some View {
        HStack(spacing: 14) {
            Spacer(minLength: 0)
            if let action = navigator.focused {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(action.label).font(.system(size: 17, weight: .black))
                    if !action.detail.isEmpty {
                        Text(action.detail).font(.system(size: 12)).foregroundStyle(TimiColor.muted)
                            .multilineTextAlignment(.trailing).lineLimit(2)
                    }
                }
            }
            actionButton
        }
        .frame(width: boxWidth, alignment: .trailing)
        .gesture(groupOnlyDrag)
    }

    private var track: some View {
        DuoTrack(pivot: pivot, radius: radius, from: focusAngle - step * 1.7,
                 to: focusAngle + step * 1.7)
            .stroke(TimiColor.ink.faded(0.14), style: StrokeStyle(lineWidth: 26, lineCap: .round))
            .overlay(
                DuoTrack(pivot: pivot, radius: radius, from: focusAngle - step * 1.7,
                         to: focusAngle + step * 1.7)
                    .stroke(TimiColor.ink.faded(0.5), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            )
            .frame(width: boxWidth, height: boxHeight)
    }

    private var actionButton: some View {
        Button { commit() } label: {
            ZStack {
                Circle().fill(navigator.focused == nil ? TimiColor.ink.faded(0.6) : TimiColor.coral)
                Circle().stroke(TimiColor.ink, lineWidth: 3)
                Image(systemName: "checkmark")
                    .font(.system(size: 22, weight: .black))
                    .foregroundStyle(.white)
            }
            .frame(width: 84, height: 84)
        }
        .buttonStyle(.plain)
        .disabled(navigator.focused == nil)
        .accessibilityLabel("Choose \(navigator.focused?.label ?? "nothing")")
    }

    // MARK: Geometry

    private func point(at degrees: Double, radius override: CGFloat? = nil) -> CGPoint {
        let r = override ?? radius
        let theta = degrees * .pi / 180
        return CGPoint(x: pivot.x + r * cos(theta), y: pivot.y + r * sin(theta))
    }

    private func angle(to location: CGPoint) -> Double {
        atan2(location.y - pivot.y, location.x - pivot.x) * 180 / .pi
    }

    // MARK: Gestures

    private var drag: some Gesture {
        DragGesture(minimumDistance: 2)
            .onChanged { value in
                if mode.isEmpty {
                    let hub = point(at: focusAngle, radius: 92)
                    let dx = value.startLocation.x - hub.x
                    let dy = value.startLocation.y - hub.y
                    mode = sqrt(dx * dx + dy * dy) <= 54 ? "group" : "scroll"
                    startAngle = angle(to: value.startLocation)
                    startIndex = navigator.focusIndex
                    groupBaseline = 0
                }

                if mode == "scroll" {
                    // Relative, not absolute: a viewport of three cannot map a
                    // whole group onto the arc, so the thumb's *travel* is what
                    // advances the list. One window of travel, one item.
                    var travelled = angle(to: value.location) - startAngle
                    if travelled > 180 { travelled -= 360 }
                    if travelled < -180 { travelled += 360 }
                    let next = startIndex + Int((travelled / step).rounded())
                    if next != navigator.focusIndex {
                        navigator.focus(next)
                        tick()
                    }
                } else {
                    stepGroup(value.translation.height)
                }
            }
            .onEnded { _ in mode = ""; groupBaseline = 0 }
    }

    /// With one answer there is nothing to scroll, but the question can still
    /// be changed — so the vertical gesture survives where the wheel does not.
    private var groupOnlyDrag: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in stepGroup(value.translation.height) }
            .onEnded { _ in groupBaseline = 0 }
    }

    private func stepGroup(_ height: CGFloat) {
        // translation is cumulative from the gesture's start, so a step moves
        // the baseline rather than zeroing a running total.
        let travelled = height - groupBaseline
        if abs(travelled) >= 52 {
            navigator.moveGroup(travelled > 0 ? 1 : -1)
            groupBaseline = height
            tick(strong: true)
        }
    }

    private func commit() {
        guard let action = navigator.commit() else { return }
        tick(strong: true)
        onCommit(action)
    }

    private func tick(strong: Bool = false) {
        #if !SKIP && canImport(UIKit) && os(iOS)
        UIImpactFeedbackGenerator(style: strong ? .medium : .light).impactOccurred()
        #endif
    }
}

/// The diagonal track the windows ride on.
struct DuoTrack: Shape {
    var pivot: CGPoint
    var radius: CGFloat
    var from: Double
    var to: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addArc(center: pivot, radius: radius,
                    startAngle: .degrees(from), endAngle: .degrees(to), clockwise: false)
        return path
    }
}

/// A viewer window. The focused one is larger and double-bordered; its
/// neighbours are smaller and quieter, there to show what is either side.
struct DuoWindow: View {
    var action: DuoAction
    var focused: Bool
    var chosen: Bool

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: action.symbol)
                .font(.system(size: CGFloat(focused ? 24 : 17), weight: .bold))
                .foregroundStyle(TimiColor.ink)
            Text(action.label)
                .font(.system(size: CGFloat(focused ? 14 : 11), weight: focused ? .black : .semibold))
                .foregroundStyle(focused ? TimiColor.ink : TimiColor.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .padding(.horizontal, 10)
        .frame(width: CGFloat(focused ? 124 : 96), height: CGFloat(focused ? 84 : 62))
        .background(
            RoundedRectangle(cornerRadius: CGFloat(focused ? 20 : 16))
                .fill(focused ? TimiColor.blueSoft : Color.white)
        )
        .overlay(
            RoundedRectangle(cornerRadius: CGFloat(focused ? 20 : 16))
                .stroke(focused ? TimiColor.blue : TimiColor.ink.faded(0.45), lineWidth: CGFloat(focused ? 3 : 2))
        )
        // The focus window's second border — the double outline in the sketch.
        // It is what says "this one" without relying on colour alone.
        .overlay(
            RoundedRectangle(cornerRadius: CGFloat(focused ? 25 : 16))
                .stroke(focused ? TimiColor.ink : Color.clear, lineWidth: CGFloat(focused ? 2 : 0))
                .padding(-5)
        )
        .overlay(alignment: .topTrailing) {
            if chosen && !focused {
                Circle().fill(TimiColor.green).frame(width: 10, height: 10).offset(x: 4, y: -4)
            }
        }
        .opacity(Double(focused ? 1 : 0.72))
    }
}
