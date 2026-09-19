import Foundation
import SwiftUI

/// The component library, drawn from the document rather than from a fixed
/// list — so a component you design appears here beside the seeded ones with
/// no distinction between them.
public struct LabLibraryView: View {
    @EnvironmentObject var store: LabStore
    @State private var query = ""

    public init() {}

    private var groups: [(String, [LabComponent])] {
        let categories = Array(Set(store.document.components.map(\.category))).sorted()
        return categories.compactMap { category in
            let matches = store.document.components.filter {
                $0.category == category &&
                (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query))
            }
            return matches.isEmpty ? nil : (category, matches.sorted { $0.name < $1.name })
        }
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Components").font(.system(size: 15, weight: .black))
                Spacer()
                Button { store.addComponent() } label: {
                    Image(systemName: "plus.circle.fill").font(.system(size: 18))
                }
            }
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 8)

            TextField("Search", text: $query)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .padding(.horizontal, 12).padding(.bottom, 8)

            if let error = store.lastError {
                Text(error).font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(LabColor.coral)
                    .padding(.horizontal, 14).padding(.bottom, 6)
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12, pinnedViews: [.sectionHeaders]) {
                    ForEach(groups, id: \.0) { category, components in
                        Section {
                            ForEach(components) { component in
                                LabLibraryRow(component: component)
                            }
                        } header: {
                            Text(category.uppercased())
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
    var component: LabComponent

    var body: some View {
        HStack(spacing: 10) {
            thumb
            VStack(alignment: .leading, spacing: 2) {
                Text(component.name).font(.system(size: 13, weight: .bold)).foregroundStyle(LabColor.ink)
                Text("\(Int(component.defaultWidth))\u{00D7}\(Int(component.defaultHeight)) \u{00B7} used \(store.usageCount(component.id))\u{00D7}")
                    .font(.system(size: 10)).foregroundStyle(LabColor.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .contentShape(Rectangle())
        .background(store.ghost?.componentID == component.id ? LabColor.goldSoft : .clear)
        .onTapGesture { store.addToCentre(component.id) }
        .gesture(
            // Long-press then drag: a bare drag would beat the palette's own
            // scrolling and make the list unusable.
            LongPressGesture(minimumDuration: 0.22)
                .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("labRoot")))
                .onChanged { value in
                    if case .second(true, let drag?) = value {
                        store.ghost = LabStore.LabGhost(componentID: component.id, point: drag.location)
                    }
                }
                .onEnded { value in
                    if case .second(true, let drag?) = value { store.dropGhost(at: drag.location) }
                    else { store.ghost = nil }
                }
        )
        .contextMenu {
            Button("Edit") {
                store.editingComponent = component.id
                store.editingElement = component.root.id
            }
            Button("Duplicate") { store.duplicateComponent(component.id) }
            Button("Delete", role: .destructive) { store.deleteComponent(component.id) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(component.name)
        .accessibilityHint("Double tap to place it. Press and hold to drag it onto the canvas.")
    }

    /// The real component, scaled down — not an illustration of it, so what
    /// you see in the list is what lands on the canvas.
    private var thumb: some View {
        let scale = min(52 / max(component.defaultWidth, 1), 34 / max(component.defaultHeight, 1), 1)
        return ZStack {
            RoundedRectangle(cornerRadius: 7).fill(LabColor.paper)
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(LabColor.ink.opacity(0.22), lineWidth: 1.5))
            LabElementView(element: component.root)
                .frame(width: component.defaultWidth, height: component.defaultHeight)
                .scaleEffect(scale)
                .allowsHitTesting(false)
        }
        .frame(width: 58, height: 40)
    }
}
