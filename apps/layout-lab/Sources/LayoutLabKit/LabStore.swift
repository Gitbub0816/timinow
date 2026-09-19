import Foundation
import SwiftUI

public final class LabStore: ObservableObject {

    @Published public var document: LabDocument
    @Published public var screenIndex = 0
    /// A set, not one id: aligning two things to each other needs both.
    @Published public var selection: Set<UUID> = []
    /// Which component the editor is open on, if any.
    @Published public var editingComponent: UUID?
    @Published public var editingElement: UUID?
    @Published public var snapToGrid = true
    @Published public var showGrid = true
    @Published public var showRuler = false
    @Published public var ghost: LabGhost?
    @Published public var canvasFrame = LabCanvasFrame()
    /// Guides drawn while dragging, in canvas points.
    @Published public var guidesX: [Double] = []
    @Published public var guidesY: [Double] = []
    @Published public var lastError: String?

    public struct LabGhost: Equatable {
        public var componentID: UUID
        public var point: CGPoint
    }

    public init() {
        if let saved = Self.load() {
            document = saved
        } else {
            let components = LabSeed.components()
            document = LabDocument(device: LabDevice.presets[0],
                                   components: components,
                                   screens: LabSeed.screens(components))
        }
    }

    // MARK: Screens

    public var screen: LabScreen {
        get { document.screens[min(screenIndex, document.screens.count - 1)] }
        set {
            document.screens[min(screenIndex, document.screens.count - 1)] = newValue
            save()
        }
    }

    public var selectedInstances: [LabInstance] {
        screen.instances.filter { selection.contains($0.id) }
    }

    public func addScreen() {
        document.screens.append(LabScreen(name: "Screen \(document.screens.count + 1)"))
        screenIndex = document.screens.count - 1
        selection = []
        save()
    }

    public func removeScreen(at index: Int) {
        guard document.screens.count > 1, document.screens.indices.contains(index) else { return }
        document.screens.remove(at: index)
        screenIndex = min(screenIndex, document.screens.count - 1)
        selection = []
        save()
    }

    public func renameScreen(_ name: String) {
        var s = screen
        s.name = name.isEmpty ? "Untitled" : name
        screen = s
    }

    // MARK: Instances

    public func add(_ componentID: UUID, at point: CGPoint) {
        guard let component = document.component(componentID) else { return }
        var instance = LabInstance(componentID: componentID,
                                   x: snap(point.x - component.defaultWidth / 2),
                                   y: snap(point.y - component.defaultHeight / 2),
                                   width: component.defaultWidth,
                                   height: component.defaultHeight)
        clamp(&instance)
        var s = screen
        s.instances.append(instance)
        screen = s
        selection = [instance.id]
    }

    public func addToCentre(_ componentID: UUID) {
        add(componentID, at: CGPoint(x: document.device.pointWidth / 2,
                                     y: document.device.pointHeight / 2))
    }

    public func dropGhost(at point: CGPoint) {
        defer { ghost = nil }
        guard let ghost, canvasFrame.scale > 0 else { return }
        let local = CGPoint(x: (point.x - canvasFrame.origin.x) / canvasFrame.scale,
                            y: (point.y - canvasFrame.origin.y) / canvasFrame.scale)
        let slack: CGFloat = 60
        guard local.x > -slack, local.y > -slack,
              local.x < document.device.pointWidth + slack,
              local.y < document.device.pointHeight + slack else { return }
        add(ghost.componentID, at: local)
    }

    public func update(_ instance: LabInstance) {
        var s = screen
        guard let i = s.instances.firstIndex(where: { $0.id == instance.id }) else { return }
        var copy = instance
        clamp(&copy)
        s.instances[i] = copy
        screen = s
    }

    public func delete(_ ids: Set<UUID>) {
        var s = screen
        s.instances.removeAll { ids.contains($0.id) }
        screen = s
        selection.subtract(ids)
    }

    public func duplicate(_ ids: Set<UUID>) {
        var s = screen
        var made: Set<UUID> = []
        for original in s.instances where ids.contains(original.id) {
            var copy = original
            copy.id = UUID()
            copy.x += 24
            copy.y += 24
            clamp(&copy)
            s.instances.append(copy)
            made.insert(copy.id)
        }
        screen = s
        selection = made
    }

    public func bringToFront(_ ids: Set<UUID>) { reorder(ids, toFront: true) }
    public func sendToBack(_ ids: Set<UUID>) { reorder(ids, toFront: false) }

    private func reorder(_ ids: Set<UUID>, toFront: Bool) {
        var s = screen
        let moving = s.instances.filter { ids.contains($0.id) }
        s.instances.removeAll { ids.contains($0.id) }
        s.instances = toFront ? s.instances + moving : moving + s.instances
        screen = s
    }

    // MARK: Alignment — to each other, and to the canvas

    public enum LabAlign: String, CaseIterable {
        case left, centreX, right, top, centreY, bottom
        public var symbol: String {
            switch self {
            case .left: return "align.horizontal.left"
            case .centreX: return "align.horizontal.center"
            case .right: return "align.horizontal.right"
            case .top: return "align.vertical.top"
            case .centreY: return "align.vertical.center"
            case .bottom: return "align.vertical.bottom"
            }
        }
    }

    /// With two or more selected, align them to each other — to the bounding
    /// box of the selection. With one, align it to the canvas. That is the
    /// behaviour every drawing tool has and the one this app was missing.
    public func align(_ how: LabAlign) {
        let chosen = selectedInstances.filter { !$0.locked }
        guard !chosen.isEmpty else { return }

        let bounds: LabRect
        if chosen.count > 1 {
            let minX = chosen.map(\.x).min() ?? 0
            let minY = chosen.map(\.y).min() ?? 0
            let maxX = chosen.map { $0.x + $0.width }.max() ?? 0
            let maxY = chosen.map { $0.y + $0.height }.max() ?? 0
            bounds = LabRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
        } else {
            bounds = LabRect(x: 0, y: 0,
                             width: document.device.pointWidth,
                             height: document.device.pointHeight)
        }

        for var instance in chosen {
            switch how {
            case .left:    instance.x = bounds.minX
            case .centreX: instance.x = snap(bounds.midX - instance.width / 2)
            case .right:   instance.x = bounds.maxX - instance.width
            case .top:     instance.y = bounds.minY
            case .centreY: instance.y = snap(bounds.midY - instance.height / 2)
            case .bottom:  instance.y = bounds.maxY - instance.height
            }
            update(instance)
        }
    }

    /// Equal gaps between three or more, along the longer axis of the spread.
    public func distribute(horizontal: Bool) {
        let chosen = selectedInstances.filter { !$0.locked }
        guard chosen.count > 2 else { return }
        let sorted = chosen.sorted { horizontal ? $0.x < $1.x : $0.y < $1.y }
        guard let first = sorted.first, let last = sorted.last else { return }

        let span = horizontal
            ? (last.x + last.width) - first.x
            : (last.y + last.height) - first.y
        let used = sorted.reduce(0.0) { $0 + (horizontal ? $1.width : $1.height) }
        let gap = (span - used) / Double(sorted.count - 1)

        var cursor = horizontal ? first.x : first.y
        for var instance in sorted {
            if horizontal { instance.x = snap(cursor); cursor += instance.width + gap }
            else { instance.y = snap(cursor); cursor += instance.height + gap }
            update(instance)
        }
    }

    /// Give every selected instance the same width, height, or both — taken
    /// from the largest, which is almost always the one that was sized on
    /// purpose.
    public func matchSize(width: Bool, height: Bool) {
        let chosen = selectedInstances.filter { !$0.locked }
        guard chosen.count > 1 else { return }
        let w = chosen.map(\.width).max() ?? 0
        let h = chosen.map(\.height).max() ?? 0
        for var instance in chosen {
            if width { instance.width = w }
            if height { instance.height = h }
            update(instance)
        }
    }

    // MARK: Snapping to neighbours

    /// Edges and centres of everything *else* on the screen, so a drag can
    /// line up against its neighbours rather than only against the grid.
    public func snapCandidates(excluding ids: Set<UUID>) -> (x: [Double], y: [Double]) {
        var xs: [Double] = [0, document.device.pointWidth / 2, document.device.pointWidth]
        var ys: [Double] = [0, document.device.pointHeight / 2, document.device.pointHeight]
        for instance in screen.instances where !ids.contains(instance.id) {
            let f = instance.frame
            xs.append(contentsOf: [f.minX, f.midX, f.maxX])
            ys.append(contentsOf: [f.minY, f.midY, f.maxY])
        }
        return (xs, ys)
    }

    /// Pull `value` to the nearest candidate within `threshold`, and report
    /// which guide to draw. Returns the original value when nothing is close.
    public func magnet(_ value: Double, _ candidates: [Double],
                       threshold: Double = 6) -> (value: Double, guide: Double?) {
        var best: Double?
        var bestDistance = threshold
        for candidate in candidates {
            let distance = abs(candidate - value)
            if distance < bestDistance { bestDistance = distance; best = candidate }
        }
        if let best { return (best, best) }
        return (value, nil)
    }

    // MARK: Components

    public func component(_ id: UUID) -> LabComponent? { document.component(id) }

    public func updateComponent(_ component: LabComponent) {
        guard let i = document.components.firstIndex(where: { $0.id == component.id }) else { return }
        document.components[i] = component
        // Nothing to propagate by hand: every instance renders through the
        // library, so this one write is what "carries to the other screens".
        save()
    }

    public func addComponent() {
        let root = LabElement(.box, name: "Root", style: LabSeed.st {
            $0.axis = "h"; $0.spacing = 8; $0.padding = LabEdges(12)
            $0.fill = .white; $0.stroke = .ink; $0.strokeWidth = 2
            $0.cornerRadius = 14; $0.grow = true
        }, children: [LabSeed.label("New component", 14, 7)])
        let component = LabComponent(name: "Component \(document.components.count + 1)",
                                     category: "Mine", root: root, width: 240, height: 64)
        document.components.append(component)
        editingComponent = component.id
        editingElement = component.root.id
        save()
    }

    public func duplicateComponent(_ id: UUID) {
        guard let original = document.component(id) else { return }
        var copy = original
        copy.id = UUID()
        copy.name = original.name + " copy"
        copy.root = original.root.reidentified()
        document.components.append(copy)
        editingComponent = copy.id
        save()
    }

    /// Refuses while the component is on a screen: deleting one out from under
    /// its instances would leave placements pointing at nothing.
    public func deleteComponent(_ id: UUID) {
        let used = document.screens.reduce(0) { count, screen in
            count + screen.instances.filter { $0.componentID == id }.count
        }
        guard used == 0 else {
            lastError = "That component is placed \(used) time\(used == 1 ? "" : "s"). Remove those first."
            return
        }
        document.components.removeAll { $0.id == id }
        if editingComponent == id { editingComponent = nil }
        lastError = nil
        save()
    }

    public func usageCount(_ id: UUID) -> Int {
        document.screens.reduce(0) { $0 + $1.instances.filter { $0.componentID == id }.count }
    }

    // MARK: Geometry

    public func snap(_ value: Double) -> Double {
        guard snapToGrid, document.gridStep > 0 else { return value.rounded() }
        return (value / document.gridStep).rounded() * document.gridStep
    }

    private func clamp(_ instance: inout LabInstance) {
        let w = document.device.pointWidth, h = document.device.pointHeight
        instance.width = max(16, instance.width)
        instance.height = max(12, instance.height)
        instance.x = min(max(instance.x, -instance.width + 40), w - 40)
        instance.y = min(max(instance.y, -instance.height + 30), h - 30)
    }

    public func setDevice(_ device: LabDevice) {
        document.device = device
        for i in document.screens.indices {
            for j in document.screens[i].instances.indices {
                clamp(&document.screens[i].instances[j])
            }
        }
        save()
    }

    // MARK: Persistence and export

    public static func encoder(pretty: Bool) -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : []
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    public func exportJSON() -> String {
        var out = document
        out.exportedAt = Date()
        out.version = LabDocument.currentVersion
        guard let data = try? Self.encoder(pretty: true).encode(out),
              let text = String(data: data, encoding: .utf8) else {
            return "{\n  \"error\": \"the configuration could not be encoded\"\n}"
        }
        return text
    }

    public func writeExport() -> URL? {
        guard let dir = Self.documentsDirectory else {
            lastError = "No documents directory on this device."
            return nil
        }
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let url = dir.appendingPathComponent("timi-layout-\(stamp).json")
        do {
            try exportJSON().write(to: url, atomically: true, encoding: .utf8)
            lastError = nil
            return url
        } catch {
            lastError = error.localizedDescription
            return nil
        }
    }

    public func importJSON(_ text: String) -> Bool {
        guard let data = text.data(using: .utf8) else { return false }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let doc = try? decoder.decode(LabDocument.self, from: data), !doc.screens.isEmpty else {
            return false
        }
        document = doc
        screenIndex = 0
        selection = []
        save()
        return true
    }

    public func resetToSeed() {
        let components = LabSeed.components()
        document = LabDocument(device: document.device,
                               components: components,
                               screens: LabSeed.screens(components))
        screenIndex = 0
        selection = []
        editingComponent = nil
        save()
    }

    private static var documentsDirectory: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    }

    private static var autosaveURL: URL? {
        documentsDirectory?.appendingPathComponent("layout-lab-v2.json")
    }

    public func save() {
        guard let url = Self.autosaveURL else { return }
        do {
            try Self.encoder(pretty: false).encode(document).write(to: url, options: .atomic)
        } catch {
            lastError = error.localizedDescription
        }
    }

    private static func load() -> LabDocument? {
        guard let url = autosaveURL, let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(LabDocument.self, from: data)
    }
}
