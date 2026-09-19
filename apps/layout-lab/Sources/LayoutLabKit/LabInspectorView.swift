import Foundation
import SwiftUI

/// The right-hand pane on the screens tab: what is selected, where it sits,
/// and the operations that need more than one thing selected.
public struct LabInspectorView: View {
    @EnvironmentObject var store: LabStore

    public init() {}

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if store.selection.isEmpty {
                    empty
                } else if store.selection.count > 1 {
                    multiple
                    arrangement
                } else if let instance = store.selectedInstances.first {
                    single(instance)
                    arrangement
                }
            }
            .padding(14)
        }
        .background(LabColor.canvas)
    }

    private var empty: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Nothing selected").font(.system(size: 15, weight: .black))
            Text("Tap a component to edit it. Tap another while one is selected, then use Arrange to line them up with each other.")
                .font(.system(size: 12)).foregroundStyle(LabColor.muted)
            Divider()
            LabSectionLabel(text: "Screen")
            Text("\(store.screen.instances.count) placed")
                .font(.system(size: 12)).foregroundStyle(LabColor.muted)
        }
    }

    private var multiple: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(store.selection.count) selected")
                .font(.system(size: 17, weight: .black))
            Text("Align and distribute act on these, relative to each other.")
                .font(.system(size: 11)).foregroundStyle(LabColor.muted)
        }
    }

    @ViewBuilder
    private func single(_ instance: LabInstance) -> some View {
        let component = store.component(instance.componentID)

        VStack(alignment: .leading, spacing: 3) {
            Text(component?.name ?? "Missing component")
                .font(.system(size: 17, weight: .black))
            Text("used \(store.usageCount(instance.componentID))\u{00D7} across screens")
                .font(.system(size: 11)).foregroundStyle(LabColor.muted)
        }

        LabMiniButton(title: "Edit this component", wide: true, tint: LabColor.blue) {
            store.editingComponent = instance.componentID
            store.editingElement = component?.root.id
        }
        Text("Editing changes every instance of it, on every screen.")
            .font(.system(size: 10)).foregroundStyle(LabColor.muted)

        VStack(alignment: .leading, spacing: 8) {
            LabSectionLabel(text: "Frame")
            HStack(spacing: 8) {
                LabNumberField(title: "X", value: instance.x,
                               onChange: set(instance) { $0.x = $1 })
                LabNumberField(title: "Y", value: instance.y,
                               onChange: set(instance) { $0.y = $1 })
            }
            HStack(spacing: 8) {
                LabNumberField(title: "W", value: instance.width,
                               onChange: set(instance) { $0.width = max(16, $1) })
                LabNumberField(title: "H", value: instance.height,
                               onChange: set(instance) { $0.height = max(12, $1) })
            }
        }

        VStack(alignment: .leading, spacing: 8) {
            LabSectionLabel(text: "Orientation")
            HStack(spacing: 6) {
                ForEach([0.0, 90.0, 180.0, 270.0], id: \.self) { angle in
                    LabMiniButton(title: "\(Int(angle))\u{00B0}", wide: true,
                                  tint: abs(instance.rotation - angle) < 0.5 ? LabColor.blue : LabColor.ink) {
                        var turned = instance
                        turned.rotation = angle
                        store.update(turned)
                    }
                }
            }
            LabSlider(title: "Free", value: instance.rotation, range: -180...180, step: 1) { angle in
                var turned = instance
                turned.rotation = angle
                store.update(turned)
            }
        }

        VStack(alignment: .leading, spacing: 8) {
            LabSectionLabel(text: "This placement only")
            TextField("Override the text", text: Binding(
                get: { instance.overrideText },
                set: { text in var copy = instance; copy.overrideText = text; store.update(copy) }
            ))
            .textFieldStyle(.roundedBorder)
            Toggle("Scale to fit the frame", isOn: Binding(
                get: { instance.scaleToFit },
                set: { on in var copy = instance; copy.scaleToFit = on; store.update(copy) }
            ))
            .font(.system(size: 13, weight: .semibold))
            Toggle("Locked", isOn: Binding(
                get: { instance.locked },
                set: { on in var copy = instance; copy.locked = on; store.update(copy) }
            ))
            .font(.system(size: 13, weight: .semibold))
        }
    }

    private var arrangement: some View {
        VStack(alignment: .leading, spacing: 10) {
            LabSectionLabel(text: store.selection.count > 1 ? "Align to each other" : "Align to canvas")
            HStack(spacing: 6) {
                ForEach(LabStore.LabAlign.allCases, id: \.self) { how in
                    LabMiniButton(symbol: how.symbol, wide: true) { store.align(how) }
                }
            }

            LabSectionLabel(text: "Distribute")
            HStack(spacing: 6) {
                LabMiniButton(title: "Across", wide: true) { store.distribute(horizontal: true) }
                LabMiniButton(title: "Down", wide: true) { store.distribute(horizontal: false) }
            }
            if store.selection.count < 3 {
                Text("Needs three or more.")
                    .font(.system(size: 10)).foregroundStyle(LabColor.muted)
            }

            LabSectionLabel(text: "Match size")
            HStack(spacing: 6) {
                LabMiniButton(title: "Width", wide: true) { store.matchSize(width: true, height: false) }
                LabMiniButton(title: "Height", wide: true) { store.matchSize(width: false, height: true) }
                LabMiniButton(title: "Both", wide: true) { store.matchSize(width: true, height: true) }
            }

            LabSectionLabel(text: "Order")
            HStack(spacing: 6) {
                LabMiniButton(title: "Front", wide: true) { store.bringToFront(store.selection) }
                LabMiniButton(title: "Back", wide: true) { store.sendToBack(store.selection) }
            }

            HStack(spacing: 6) {
                LabMiniButton(title: "Duplicate", wide: true) { store.duplicate(store.selection) }
                LabMiniButton(title: "Delete", wide: true, tint: LabColor.coral) {
                    store.delete(store.selection)
                }
            }
            .padding(.top, 4)
        }
    }

    private func set(_ instance: LabInstance,
                     _ apply: @escaping (inout LabInstance, Double) -> Void) -> (Double) -> Void {
        { value in
            var copy = instance
            apply(&copy, value)
            store.update(copy)
        }
    }
}
