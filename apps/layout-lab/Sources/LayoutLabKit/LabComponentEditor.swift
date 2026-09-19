import Foundation
import SwiftUI

/// Designing a component, rather than placing one.
///
/// Three panes: the element tree, a live preview at the component's own size,
/// and every style property of whatever is selected. Nothing here is special —
/// the seeded library is built from exactly these primitives, so any component
/// can be opened, taken apart, and rebuilt.
public struct LabComponentEditor: View {
    @EnvironmentObject var store: LabStore
    public init() {}

    private var component: LabComponent? {
        store.editingComponent.flatMap { store.component($0) }
    }

    public var body: some View {
        if let component {
            HStack(spacing: 0) {
                tree(component).frame(width: 268)
                Divider()
                preview(component).frame(maxWidth: .infinity)
                Divider()
                styles(component).frame(width: 300)
            }
        } else {
            VStack(spacing: 12) {
                Text("No component open").font(.system(size: 17, weight: .black))
                Text("Pick one from the library, or make a new one.")
                    .font(.system(size: 13)).foregroundStyle(LabColor.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(LabColor.canvas)
        }
    }

    // MARK: Tree

    private func tree(_ component: LabComponent) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text("Elements").font(.system(size: 15, weight: .black))
                Spacer()
                Menu {
                    ForEach(LabElementKind.allCases, id: \.self) { kind in
                        Button(kind.title) { addElement(kind, to: component) }
                    }
                } label: {
                    Image(systemName: "plus.circle.fill").font(.system(size: 18))
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    LabTreeRow(element: component.root, depth: 0)
                }
                .padding(.horizontal, 8).padding(.bottom, 20)
            }

            Divider()
            VStack(alignment: .leading, spacing: 8) {
                LabSectionLabel(text: "Component")
                TextField("Name", text: Binding(
                    get: { component.name },
                    set: { var c = component; c.name = $0; store.updateComponent(c) }
                ))
                .textFieldStyle(.roundedBorder)
                HStack(spacing: 8) {
                    LabNumberField(title: "W", value: component.defaultWidth) { w in
                        var c = component; c.defaultWidth = max(16, w); store.updateComponent(c)
                    }
                    LabNumberField(title: "H", value: component.defaultHeight) { h in
                        var c = component; c.defaultHeight = max(12, h); store.updateComponent(c)
                    }
                }
                Text("New placements start at this size.")
                    .font(.system(size: 10)).foregroundStyle(LabColor.muted)
            }
            .padding(14)
        }
        .background(LabColor.canvas)
    }

    private func addElement(_ kind: LabElementKind, to component: LabComponent) {
        var style = LabStyle()
        switch kind {
        case .text: style.fontSize = 14; style.fontWeight = 6
        case .glyph: style.fontSize = 16; style.fontWeight = 7
        case .dot: style.fill = .ink; style.fixedWidth = 10; style.fixedHeight = 10
        case .capsuleBar: style.fill = .ink; style.fixedWidth = 40; style.fixedHeight = 8
        case .divider: style.stroke = .ink; style.fixedHeight = 1; style.grow = true
        case .spacer: style.grow = true
        case .box, .stack: style.grow = true; style.spacing = 8; style.padding = LabEdges(8)
        }
        let element = LabElement(kind, text: kind == .text ? "Text" : "", style: style)

        // Into the selected element if it can hold children, otherwise into
        // the root — never silently nowhere.
        var copy = component
        let target = store.editingElement.flatMap { copy.root.find($0) }
        let parent = (target?.kind.takesChildren == true ? target?.id : nil) ?? copy.root.id
        copy.root.insert(element, into: parent)
        store.updateComponent(copy)
        store.editingElement = element.id
    }

    // MARK: Preview

    private func preview(_ component: LabComponent) -> some View {
        VStack(spacing: 14) {
            Text("Actual size \u{00B7} \(Int(component.defaultWidth)) \u{00D7} \(Int(component.defaultHeight)) pt")
                .font(.system(size: 11, weight: .black)).tracking(1)
                .foregroundStyle(LabColor.muted)

            LabElementView(element: component.root)
                .frame(width: component.defaultWidth, height: component.defaultHeight)
                .overlay(Rectangle().stroke(LabColor.blue.opacity(0.35),
                                            style: StrokeStyle(lineWidth: 1, dash: [4, 4])))

            Text("Nothing is clipped. If the contents overflow, the frame is too small \u{2014} which is what you want to see.")
                .font(.system(size: 11)).foregroundStyle(LabColor.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(LabColor.paper)
    }

    // MARK: Styles

    @ViewBuilder
    private func styles(_ component: LabComponent) -> some View {
        ScrollView {
            if let id = store.editingElement, let element = component.root.find(id) {
                LabStyleInspector(component: component, element: element)
                    .padding(14)
            } else {
                Text("Select an element on the left.")
                    .font(.system(size: 12)).foregroundStyle(LabColor.muted)
                    .padding(14)
            }
        }
        .background(LabColor.canvas)
    }
}

// MARK: - Tree row

struct LabTreeRow: View {
    @EnvironmentObject var store: LabStore
    var element: LabElement
    var depth: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Spacer().frame(width: CGFloat(depth) * 14)
                Image(systemName: symbol)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(LabColor.muted)
                Text(element.kind == .text && !element.text.isEmpty ? element.text : element.name)
                    .font(.system(size: 12, weight: store.editingElement == element.id ? .black : .medium))
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(store.editingElement == element.id ? LabColor.blueSoft : .clear,
                        in: RoundedRectangle(cornerRadius: 7))
            .contentShape(Rectangle())
            .onTapGesture { store.editingElement = element.id }

            ForEach(element.children) { child in
                LabTreeRow(element: child, depth: depth + 1)
            }
        }
    }

    private var symbol: String {
        switch element.kind {
        case .stack: return element.style.axis == "v" ? "arrow.up.and.down" : "arrow.left.and.right"
        case .box: return "square"
        case .text: return "textformat"
        case .glyph: return "star"
        case .spacer: return "arrow.left.and.right.square"
        case .divider: return "minus"
        case .dot: return "circle.fill"
        case .capsuleBar: return "capsule.fill"
        }
    }
}

// MARK: - Style inspector

struct LabStyleInspector: View {
    @EnvironmentObject var store: LabStore
    var component: LabComponent
    var element: LabElement

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            if element.kind == .text { textSection }
            if element.kind == .glyph { glyphSection }
            if element.kind.takesChildren { layoutSection }
            sizeSection
            paintSection
            transformSection
            if element.id != component.root.id { removeButton }
        }
    }

    // MARK: Plumbing
    //
    // One mutation path: change the element, write it back into the
    // component's tree, and hand the component to the store. Every instance
    // on every screen re-renders from that one write.

    private func mutate(_ apply: (inout LabElement) -> Void) {
        var updated = element
        apply(&updated)
        var copy = component
        copy.root.replace(element.id, with: updated)
        store.updateComponent(copy)
    }

    private func text(_ path: WritableKeyPath<LabElement, String>) -> Binding<String> {
        Binding(get: { element[keyPath: path] },
                set: { value in mutate { $0[keyPath: path] = value } })
    }

    private func flag(_ get: @escaping () -> Bool,
                      _ set: @escaping (inout LabElement, Bool) -> Void) -> Binding<Bool> {
        Binding(get: get, set: { on in mutate { set(&$0, on) } })
    }

    // MARK: Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(element.kind.title).font(.system(size: 17, weight: .black))
            TextField("Name", text: text(\.name)).textFieldStyle(.roundedBorder)
        }
    }

    private var textSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabSectionLabel(text: "Text")
            TextField("Words", text: text(\.text), axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
            LabSlider(title: "Size", value: element.style.fontSize, range: 6...72,
                      onChange: { v in mutate { $0.style.fontSize = v } })
            LabSlider(title: "Weight", value: Double(element.style.fontWeight), range: 1...9,
                      onChange: { v in mutate { $0.style.fontWeight = Int(v) } })
            Text(LabFont.names[max(0, min(8, element.style.fontWeight - 1))])
                .font(.system(size: 10)).foregroundStyle(LabColor.muted)
            LabSlider(title: "Tracking", value: element.style.tracking, range: -2...8, step: 0.5,
                      onChange: { v in mutate { $0.style.tracking = v } })
            LabSlider(title: "Lines", value: Double(element.style.lineLimit), range: 0...6,
                      onChange: { v in mutate { $0.style.lineLimit = Int(v) } })
            Text("Zero lines means as many as it takes. Text shrinks before it truncates and never gets clipped.")
                .font(.system(size: 10)).foregroundStyle(LabColor.muted)
            Toggle("Serif", isOn: flag({ element.style.serif }, { e, on in e.style.serif = on }))
                .font(.system(size: 13, weight: .semibold))
            LabPaintPicker(title: "Text colour", paint: element.style.textColor) { paint in
                mutate { $0.style.textColor = paint }
            }
        }
    }

    private var glyphSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabSectionLabel(text: "Icon")
            TextField("SF Symbol name", text: text(\.symbol))
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            Text("Any SF Symbol name, e.g. pawprint.fill")
                .font(.system(size: 10)).foregroundStyle(LabColor.muted)
            LabSlider(title: "Size", value: element.style.fontSize, range: 6...80,
                      onChange: { v in mutate { $0.style.fontSize = v } })
            LabPaintPicker(title: "Colour", paint: element.style.textColor) { paint in
                mutate { $0.style.textColor = paint }
            }
        }
    }

    private var layoutSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabSectionLabel(text: "Layout")
            HStack(spacing: 6) {
                axisButton("h", "Row")
                axisButton("v", "Column")
                axisButton("z", "Stacked")
            }
            Text("Switching a row to a column is how a tab bar becomes a side rail \u{2014} same children, one property.")
                .font(.system(size: 10)).foregroundStyle(LabColor.muted)
            LabSlider(title: "Spacing", value: element.style.spacing, range: 0...40,
                      onChange: { v in mutate { $0.style.spacing = v } })
            HStack(spacing: 6) {
                alignButton("leading", "Start")
                alignButton("center", "Middle")
                alignButton("trailing", "End")
            }
            LabSlider(title: "Padding", value: element.style.padding.top, range: 0...48,
                      onChange: { v in mutate { $0.style.padding = LabEdges(v) } })
        }
    }

    private var sizeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabSectionLabel(text: "Size")
            HStack(spacing: 8) {
                LabNumberField(title: "Fixed W", value: element.style.fixedWidth ?? 0,
                               onChange: { v in mutate { $0.style.fixedWidth = v <= 0 ? nil : v } })
                LabNumberField(title: "Fixed H", value: element.style.fixedHeight ?? 0,
                               onChange: { v in mutate { $0.style.fixedHeight = v <= 0 ? nil : v } })
            }
            Text("Zero means whatever the content needs.")
                .font(.system(size: 10)).foregroundStyle(LabColor.muted)
            Toggle("Fill the space along the parent\u{2019}s axis",
                   isOn: flag({ element.style.grow }, { e, on in e.style.grow = on }))
                .font(.system(size: 13, weight: .semibold))
        }
    }

    private var paintSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            LabPaintPicker(title: "Fill", paint: element.style.fill) { paint in
                mutate { $0.style.fill = paint }
            }
            LabPaintPicker(title: "Border", paint: element.style.stroke) { paint in
                mutate { $0.style.stroke = paint }
            }
            LabSlider(title: "Border", value: element.style.strokeWidth, range: 0...8, step: 0.5,
                      onChange: { v in mutate { $0.style.strokeWidth = v } })
            LabSlider(title: "Corner", value: element.style.cornerRadius, range: 0...200,
                      onChange: { v in mutate { $0.style.cornerRadius = v } })
            LabSlider(title: "Shadow", value: element.style.shadowOffset, range: 0...14,
                      onChange: { v in mutate { $0.style.shadowOffset = v } })
            Text("Hard offset, zero blur \u{2014} the house treatment.")
                .font(.system(size: 10)).foregroundStyle(LabColor.muted)
        }
    }

    private var transformSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabSectionLabel(text: "Transform")
            LabSlider(title: "Rotate", value: element.style.rotation, range: -180...180,
                      onChange: { v in mutate { $0.style.rotation = v } })
            LabSlider(title: "Opacity", value: element.style.opacity, range: 0...1, step: 0.05,
                      onChange: { v in mutate { $0.style.opacity = v } })
        }
    }

    private var removeButton: some View {
        LabMiniButton(title: "Delete element", wide: true, tint: LabColor.coral) {
            var copy = component
            copy.root.remove(element.id)
            store.updateComponent(copy)
            store.editingElement = copy.root.id
        }
    }

    private func axisButton(_ axis: String, _ title: String) -> some View {
        LabMiniButton(title: title, wide: true,
                      tint: element.style.axis == axis ? LabColor.blue : LabColor.ink) {
            mutate { $0.style.axis = axis }
        }
    }

    private func alignButton(_ value: String, _ title: String) -> some View {
        LabMiniButton(title: title, wide: true,
                      tint: element.style.alignment == value ? LabColor.blue : LabColor.ink) {
            mutate { $0.style.alignment = value }
        }
    }
}
