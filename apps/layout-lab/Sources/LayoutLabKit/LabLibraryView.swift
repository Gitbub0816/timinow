import SwiftUI

/// The palette.
///
/// Drag an entry onto the canvas, or tap it to drop one in the middle. The
/// drag is a plain `DragGesture` driving a ghost in the root overlay rather
/// than `Transferable`/`dropDestination`: the payload never leaves the
/// process, so conforming a type to `Transferable` to move a UUID across two
/// panes of the same window is ceremony with no benefit.
public struct LabLibraryView: View {
    @EnvironmentObject var store: LabStore
    @State private var query: String = ""

    public init() {}

    private var groups: [(LabKind.Group, [LabKind])] {
        LabKind.Group.allCases.compactMap { group in
            let kinds = LabKind.allCases.filter {
                $0.group == group && (query.isEmpty
                                      || $0.title.localizedCaseInsensitiveContains(query)
                                      || $0.blurb.localizedCaseInsensitiveContains(query))
            }
            return kinds.isEmpty ? nil : (group, kinds)
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Components").font(.system(size: 15, weight: .black))
                Spacer()
                Text("\(LabKind.allCases.count)")
                    .font(.system(size: 11, weight: .black)).foregroundStyle(LabColor.muted)
            }
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)

            TextField("Search", text: $query)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .padding(.horizontal, 12).padding(.bottom, 8)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14, pinnedViews: [.sectionHeaders]) {
                    ForEach(groups, id: \.0) { group, kinds in
                        Section {
                            ForEach(kinds, id: \.self) { kind in
                                LabLibraryRow(kind: kind)
                            }
                        } header: {
                            Text(group.rawValue.uppercased())
                                .font(.system(size: 10, weight: .black)).tracking(1.4)
                                .foregroundStyle(LabColor.coral)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 14).padding(.vertical, 6)
                                .background(LabColor.canvas)
                        }
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .background(LabColor.canvas)
    }
}

struct LabLibraryRow: View {
    @EnvironmentObject var store: LabStore
    var kind: LabKind

    var body: some View {
        HStack(spacing: 10) {
            LabKindThumb(kind: kind)
            VStack(alignment: .leading, spacing: 1) {
                Text(kind.title).font(.system(size: 13, weight: .bold)).foregroundStyle(LabColor.ink)
                Text(kind.blurb).font(.system(size: 11)).foregroundStyle(LabColor.muted)
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .contentShape(Rectangle())
        .background(store.ghost?.kind == kind ? LabColor.goldSoft : .clear)
        .onTapGesture { store.addToCentre(kind) }
        // Long-press, then drag. A bare DragGesture here would win against
        // the enclosing ScrollView's pan and make the palette unscrollable;
        // sequencing it behind a press is both the fix and the affordance
        // people already expect for dragging something out of a list.
        .gesture(
            LongPressGesture(minimumDuration: 0.22)
                .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("labRoot")))
                .onChanged { value in
                    switch value {
                    case .second(true, let drag?):
                        store.ghost = LabStore.LabGhost(kind: kind, point: drag.location)
                    default:
                        break
                    }
                }
                .onEnded { value in
                    if case .second(true, let drag?) = value {
                        store.dropGhost(at: drag.location)
                    } else {
                        store.ghost = nil
                    }
                }
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(kind.title). \(kind.blurb)")
        .accessibilityHint("Double tap to add it to the middle of the screen, or press and hold then drag it onto the canvas.")
    }
}

/// A miniature of the component, so the list reads as shapes rather than text.
struct LabKindThumb: View {
    var kind: LabKind

    var body: some View {
        let size = kind.defaultSize
        let scale = min(46 / size.width, 30 / size.height, 1)
        ZStack {
            RoundedRectangle(cornerRadius: 7).fill(.white)
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(LabColor.ink.opacity(0.25), lineWidth: 1.5))
            LabComponentView(node: LabNode(kind: kind, x: 0, y: 0))
                .scaleEffect(scale)
                .allowsHitTesting(false)
        }
        .frame(width: 54, height: 38)
        .clipped()
    }
}
