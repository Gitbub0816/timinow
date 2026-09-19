import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

/// Everything that is not the wheel.
///
/// The stage answers one question at a time, in type large enough to read at
/// arm's length, and it never scrolls: if a group has ten answers, the wheel
/// carries them and the stage shows the one in focus. The alternative — a
/// scrolling list plus a wheel — would be two navigation systems arguing.
struct DuoStage: View {
    var navigator: DuoNavigator
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            answered
            Spacer(minLength: 0)
            focusPanel
            Spacer(minLength: 0)
            notice
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    // MARK: What has already been answered

    private var answered: some View {
        HStack(spacing: 10) {
            ForEach(navigator.groups) { group in
                if group.kind != .menu, let label = navigator.chosenLabel(group.id) {
                    HStack(spacing: 6) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .black))
                            .foregroundStyle(TimiColor.green)
                            .accessibilityHidden(true)
                        Text(label).font(.system(size: 13, weight: .bold))
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Color.white, in: Capsule())
                    .overlay(Capsule().stroke(TimiColor.ink.faded(0.3), lineWidth: 1.5))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.bottom, 8)
    }

    /// "Select Bill's species · 3 of 6". The count is dropped for a group with
    /// one answer, where it would only ever read "1 of 1".
    private var groupHeading: String {
        let total = navigator.group.actions.count
        guard total > 1 else { return navigator.group.label }
        return "\(navigator.group.label) · \(navigator.focusIndex + 1) of \(total)"
    }

    // MARK: The focused answer

    @ViewBuilder private var focusPanel: some View {
        if let action = navigator.focused {
            VStack(alignment: .leading, spacing: 14) {
                // The question, and where you are inside it. The wheel shows
                // three answers at a time on purpose, so without a count a long
                // group gives no sense of how much is left — and the wheel has
                // no room for the number without crowding the thumb.
                Text(groupHeading)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(TimiColor.muted)

                HStack(alignment: .center, spacing: 22) {
                    Image(systemName: action.symbol)
                        .font(.system(size: 54, weight: .bold))
                        .foregroundStyle(TimiColor.blue)
                        .frame(width: 96, height: 96)
                        .background(TimiColor.blueSoft, in: RoundedRectangle(cornerRadius: 26))
                        .overlay(RoundedRectangle(cornerRadius: 26).stroke(TimiColor.ink, lineWidth: 2))
                        .shadow(color: TimiColor.ink.faded(0.9), radius: 0, x: 5, y: 6)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 6) {
                        Text(action.label)
                            .font(.system(size: 46, weight: .black))
                            .minimumScaleFactor(0.5)
                            .lineLimit(2)
                        if !action.detail.isEmpty {
                            Text(action.detail)
                                .font(.system(size: 17))
                                .foregroundStyle(TimiColor.muted)
                        }
                    }
                }

                if navigator.canTurn {
                    Text("Turn the wheel to change this. Press the middle to choose it.")
                        .font(.system(size: 14)).foregroundStyle(TimiColor.muted)
                } else {
                    Text("Press the middle to choose it.")
                        .font(.system(size: 14)).foregroundStyle(TimiColor.muted)
                }
            }
            .id(action.id)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: action.id)
        } else {
            Text("Nothing to choose here.")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(TimiColor.muted)
        }
    }

    private var notice: some View {
        Text("Tími is not a veterinary practice and does not give medical advice. If it looks bad, go now.")
            .font(.system(size: 12))
            .foregroundStyle(TimiColor.muted)
            .padding(.top, 10)
    }
}

/// The menu, as a vertical bar down the far edge.
///
/// It is a group like any other — the wheel turns through it and the hub
/// commits it — but it is the one group whose whole list is worth keeping on
/// screen, because it is how you know where you are. Collapsed to icons while
/// another question is being asked; expanded with labels when the menu itself
/// is the question.
struct DuoMenuBar: View {
    var navigator: DuoNavigator
    var expanded: Bool
    /// The section actually showing, not the last thing the wheel committed —
    /// those diverge the moment you turn the wheel past your own destination.
    var currentID: String
    var onPick: (DuoAction) -> Void

    private var menu: DuoGroup {
        navigator.groups.first { $0.kind == .menu } ?? DuoContent.menu()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(menu.actions.enumerated()), id: \.element.id) { index, action in
                // A real Button, not a row the wheel happens to point at:
                // the wheel is an accelerator and never the only way in.
                Button {
                    onPick(action)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: action.symbol)
                            .font(.system(size: 19, weight: .bold))
                            .frame(width: 30)
                        if expanded {
                            Text(action.label)
                                .font(.system(size: 16, weight: .bold))
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                    }
                    .foregroundStyle(isCurrent(action) ? Color.white : TimiColor.ink)
                    .padding(.horizontal, 12).padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(background(action), in: RoundedRectangle(cornerRadius: 14))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(isFocused(action) ? TimiColor.blue : Color.clear, lineWidth: 3)
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(action.label)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(width: CGFloat(expanded ? 232 : 66))
        .background(TimiColor.paper)
        .overlay(Rectangle().frame(width: 2).foregroundStyle(TimiColor.ink), alignment: .trailing)
    }

    private func isCurrent(_ action: DuoAction) -> Bool { currentID == action.id }

    private func isFocused(_ action: DuoAction) -> Bool {
        navigator.group.kind == .menu && navigator.focused?.id == action.id
    }

    private func background(_ action: DuoAction) -> Color {
        if isCurrent(action) { return TimiColor.ink }
        if isFocused(action) { return TimiColor.blueSoft }
        return .clear
    }
}
