import SwiftUI

/// Properties of the selection, plus the operations that are miserable by
/// hand: exact frames, alignment against the canvas, z-order, lock.
public struct LabInspectorView: View {
    @EnvironmentObject var store: LabStore

    public init() {}

    public var body: some View {
        ScrollView {
            if let node = store.selectedNode {
                VStack(alignment: .leading, spacing: 16) {
                    header(node)
                    frameFields(node)
                    labelField(node)
                    if node.kind.variantCount > 1 { variantPicker(node) }
                    alignment(node)
                    order(node)
                    danger(node)
                }
                .padding(14)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Nothing selected").font(.system(size: 15, weight: .black))
                    Text("Tap a component on the canvas to edit it, or drag one in from the left.")
                        .font(.system(size: 12)).foregroundStyle(LabColor.muted)
                    Divider().padding(.vertical, 6)
                    Text("SCREEN").font(.system(size: 10, weight: .black)).tracking(1.4)
                        .foregroundStyle(LabColor.coral)
                    Text("\(store.screen.nodes.count) component\(store.screen.nodes.count == 1 ? "" : "s")")
                        .font(.system(size: 12)).foregroundStyle(LabColor.muted)
                }
                .padding(14)
            }
        }
        .background(LabColor.canvas)
    }

    private func header(_ node: LabNode) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(node.kind.title).font(.system(size: 17, weight: .black)).foregroundStyle(LabColor.ink)
            Text(node.kind.rawValue).font(.system(size: 11, design: .monospaced))
                .foregroundStyle(LabColor.muted)
        }
    }

    private func frameFields(_ node: LabNode) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("FRAME").font(.system(size: 10, weight: .black)).tracking(1.4).foregroundStyle(LabColor.coral)
            HStack(spacing: 8) {
                LabNumberField(title: "X", value: node.x, onChange: set(node) { $0.x = $1 })
                LabNumberField(title: "Y", value: node.y, onChange: set(node) { $0.y = $1 })
            }
            HStack(spacing: 8) {
                LabNumberField(title: "W", value: node.width, onChange: set(node) { $0.width = max(24, $1) })
                LabNumberField(title: "H", value: node.height, onChange: set(node) { $0.height = max(18, $1) })
            }
        }
    }

    private func labelField(_ node: LabNode) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("LABEL").font(.system(size: 10, weight: .black)).tracking(1.4).foregroundStyle(LabColor.coral)
            TextField("Default copy", text: Binding(
                get: { node.label },
                set: { text in var n = node; n.label = text; store.update(n) }
            ))
            .textFieldStyle(.roundedBorder)
            Text("Empty uses the component's own words.")
                .font(.system(size: 10)).foregroundStyle(LabColor.muted)
        }
    }

    private func variantPicker(_ node: LabNode) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("VARIANT").font(.system(size: 10, weight: .black)).tracking(1.4).foregroundStyle(LabColor.coral)
            Picker("Variant", selection: Binding(
                get: { node.variant },
                set: { v in var n = node; n.variant = v; store.update(n) }
            )) {
                ForEach(0..<node.kind.variantCount, id: \.self) { i in
                    Text("\(i + 1)").tag(i)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private func alignment(_ node: LabNode) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ALIGN TO CANVAS").font(.system(size: 10, weight: .black)).tracking(1.4)
                .foregroundStyle(LabColor.coral)
            HStack(spacing: 6) {
                LabMiniButton(title: "L") { store.align(node.id, .left) }
                LabMiniButton(title: "C") { store.align(node.id, .centreX) }
                LabMiniButton(title: "R") { store.align(node.id, .right) }
                LabMiniButton(title: "T") { store.align(node.id, .top) }
                LabMiniButton(title: "M") { store.align(node.id, .centreY) }
                LabMiniButton(title: "B") { store.align(node.id, .bottom) }
            }
        }
    }

    private func order(_ node: LabNode) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ORDER").font(.system(size: 10, weight: .black)).tracking(1.4).foregroundStyle(LabColor.coral)
            HStack(spacing: 6) {
                LabMiniButton(title: "Front", wide: true) { store.bringToFront(node.id) }
                LabMiniButton(title: "Back", wide: true) { store.sendToBack(node.id) }
            }
            Toggle("Locked", isOn: Binding(
                get: { node.locked },
                set: { v in var n = node; n.locked = v; store.update(n) }
            ))
            .font(.system(size: 13, weight: .semibold))
        }
    }

    private func danger(_ node: LabNode) -> some View {
        HStack(spacing: 6) {
            LabMiniButton(title: "Duplicate", wide: true) { store.duplicate(node.id) }
            LabMiniButton(title: "Delete", wide: true, tint: LabColor.coral) { store.delete(node.id) }
        }
        .padding(.top, 4)
    }

    private func set(_ node: LabNode, _ apply: @escaping (inout LabNode, Double) -> Void) -> (Double) -> Void {
        { value in
            var copy = node
            apply(&copy, value)
            store.update(copy)
        }
    }
}

struct LabNumberField: View {
    var title: String
    var value: Double
    var onChange: (Double) -> Void
    @State private var text: String = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.system(size: 10, weight: .black)).foregroundStyle(LabColor.muted)
            TextField("0", text: $text)
                .keyboardType(.numbersAndPunctuation)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .monospacedDigit()
                .onSubmit { commit() }
                .onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
                .onAppear { text = format(value) }
                .onChange(of: value) { _, newValue in if !focused { text = format(newValue) } }
        }
    }

    private func format(_ v: Double) -> String { String(Int(v.rounded())) }
    private func commit() {
        if let parsed = Double(text.trimmingCharacters(in: .whitespaces)) { onChange(parsed) }
        text = format(value)
    }
}

struct LabMiniButton: View {
    var title: String
    var wide: Bool = false
    var tint: Color = LabColor.ink
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title).font(.system(size: 12, weight: .black)).foregroundStyle(tint)
                .frame(maxWidth: wide ? .infinity : nil, minWidth: wide ? nil : 34, minHeight: 32)
                .padding(.horizontal, wide ? 8 : 0)
                .background(RoundedRectangle(cornerRadius: 9).fill(.white)
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(tint.opacity(0.4), lineWidth: 1.5)))
        }
        .buttonStyle(.plain)
    }
}
