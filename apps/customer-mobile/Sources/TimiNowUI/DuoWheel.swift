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

    // Geometry. Every number here was settled by drawing the control at 2x and
    // measuring it, not by eye: the three windows, the track and the button all
    // have to sit inside the box with real gaps between them, and the previous
    // numbers did not — the focus window and the button overlapped, and the
    // track ran off the edge. `scripts/duo-wheel-geometry.mjs` re-checks them.
    private let boxWidth: CGFloat = 264
    private let boxHeight: CGFloat = 264
    /// How far the wheel's centre sits in from the box's bottom-trailing corner.
    /// The button is a whole circle around that centre rather than a quarter
    /// clipped by the corner, which is why this is not zero.
    private let pivotInset: CGFloat = 84
    private let radius: CGFloat = 144
    /// Degrees between adjacent windows, and therefore one item of travel.
    private let step: Double = 46
    /// Where the focus window sits: up and to the left of the thumb.
    private let focusAngle: Double = 225
    /// Half the button's width, and the radius inside which a drag is read as a
    /// change of question rather than a turn of the wheel.
    private let hubRadius: CGFloat = 58

    @State var mode = ""
    @State var startAngle: Double = 0
    @State var startIndex = 0
    @State var groupBaseline: CGFloat = 0

    private var pivot: CGPoint { CGPoint(x: boxWidth - pivotInset, y: boxHeight - pivotInset) }
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

            actionButton.position(pivot)
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

    /// The track stops where the list stops. Drawing a full sweep under a group
    /// of two would promise travel that is not there, which is the same lie a
    /// wheel that cannot turn tells.
    private var trackStart: Double {
        focusAngle - min(step * 1.3, Double(navigator.focusIndex) * step + step * 0.55)
    }

    private var trackEnd: Double {
        let remaining = Double(actions.count - 1 - navigator.focusIndex)
        return focusAngle + min(step * 1.3, remaining * step + step * 0.55)
    }

    private var track: some View {
        DuoTrack(pivot: pivot, radius: radius, from: trackStart, to: trackEnd)
            .stroke(TimiColor.ink.faded(0.4), style: StrokeStyle(lineWidth: 3, lineCap: .round))
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
            .frame(width: hubRadius * 2, height: hubRadius * 2)
            .shadow(color: TimiColor.ink.faded(0.9), radius: 0, x: 5, y: 6)
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
                    let dx = value.startLocation.x - pivot.x
                    let dy = value.startLocation.y - pivot.y
                    mode = sqrt(dx * dx + dy * dy) <= hubRadius ? "group" : "scroll"
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

/// A viewer window. The focused one is larger, filled and carries the deeper
/// drop shadow; its neighbours are smaller and quieter, there to show what is
/// either side. Size and shadow depth do the work colour alone would not — the
/// focus has to be obvious to someone who cannot tell blue from paper.
struct DuoWindow: View {
    var action: DuoAction
    var focused: Bool
    var chosen: Bool

    var body: some View {
        VStack(spacing: CGFloat(focused ? 4 : 2)) {
            Image(systemName: action.symbol)
                .font(.system(size: CGFloat(focused ? 23 : 16), weight: .bold))
                .foregroundStyle(TimiColor.ink)
            Text(action.label)
                .font(.system(size: CGFloat(focused ? 14 : 10), weight: focused ? .black : .bold))
                .foregroundStyle(focused ? TimiColor.ink : TimiColor.muted)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .padding(.horizontal, CGFloat(focused ? 10 : 6))
        .frame(width: CGFloat(focused ? 116 : 68), height: CGFloat(focused ? 72 : 52))
        .background(
            RoundedRectangle(cornerRadius: CGFloat(focused ? 18 : 15))
                .fill(focused ? TimiColor.blueSoft : TimiColor.paper)
        )
        .overlay(
            RoundedRectangle(cornerRadius: CGFloat(focused ? 18 : 15))
                .stroke(focused ? TimiColor.ink : TimiColor.ink.faded(0.5), lineWidth: 2)
        )
        .overlay(alignment: .topTrailing) {
            if chosen && !focused {
                Circle().fill(TimiColor.green).frame(width: 10, height: 10).offset(x: 4, y: -4)
            }
        }
        .shadow(color: TimiColor.ink.faded(focused ? 0.9 : 0.55), radius: 0,
                x: CGFloat(focused ? 5 : 3), y: CGFloat(focused ? 6 : 4))
        .opacity(Double(focused ? 1 : 0.62))
    }
}
