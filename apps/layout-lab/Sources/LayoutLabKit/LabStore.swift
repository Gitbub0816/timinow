import Foundation
import SwiftUI

/// Everything the app knows, in one place.
///
/// `ObservableObject` rather than `@Observable`: this is a single store read
/// by every pane, the change granularity does not matter at this size, and
/// the older protocol has no macro to go wrong.
public final class LabStore: ObservableObject {

    @Published public var document: LabDocument
    @Published public var screenIndex: Int = 0
    @Published public var selection: UUID?
    @Published public var snapToGrid: Bool = true
    @Published public var showGrid: Bool = true
    @Published public var showReach: Bool = true
    /// Set while a library item is being dragged toward the canvas.
    @Published public var ghost: LabGhost?
    @Published public var lastSaveError: String?
    /// Published upward by the canvas so a drop in window coordinates can be
    /// turned into canvas points. Zero scale means the canvas has not laid
    /// out yet, and a drop is ignored rather than landing at infinity.
    @Published public var canvasFrame = LabCanvasFrame()

    public struct LabGhost: Equatable {
        public var kind: LabKind
        public var point: CGPoint
    }

    public init() {
        document = Self.load() ?? LabDocument(device: LabDevice.presets[0], screens: LabSeed.screens())
    }

    // MARK: Screens

    public var screen: LabScreen {
        get { document.screens[min(screenIndex, document.screens.count - 1)] }
        set { document.screens[min(screenIndex, document.screens.count - 1)] = newValue; save() }
    }

    public var selectedNode: LabNode? {
        guard let selection else { return nil }
        return screen.nodes.first { $0.id == selection }
    }

    public func addScreen() {
        document.screens.append(LabScreen(name: "Screen \(document.screens.count + 1)"))
        screenIndex = document.screens.count - 1
        selection = nil
        save()
    }

    public func removeScreen(at index: Int) {
        guard document.screens.count > 1, document.screens.indices.contains(index) else { return }
        document.screens.remove(at: index)
        screenIndex = min(screenIndex, document.screens.count - 1)
        selection = nil
        save()
    }

    public func renameScreen(_ name: String) {
        var s = screen
        s.name = name.isEmpty ? "Untitled" : name
        screen = s
    }

    // MARK: Nodes

    public func add(_ kind: LabKind, at point: CGPoint) {
        var node = LabNode(kind: kind, x: 0, y: 0)
        // Drop centred on the finger, then clamp so nothing lands off-canvas
        // where it cannot be grabbed again.
        node.x = snap(point.x - node.width / 2)
        node.y = snap(point.y - node.height / 2)
        clamp(&node)
        var s = screen
        s.nodes.append(node)
        screen = s
        selection = node.id
    }

    /// Tap-to-add. Lands in the middle, which is always visible and always
    /// draggable from — unlike a drop that missed the canvas.
    public func addToCentre(_ kind: LabKind) {
        add(kind, at: CGPoint(x: document.device.width / 2, y: document.device.height / 2))
    }

    /// Finish a library drag. `point` is in the root coordinate space.
    public func dropGhost(at point: CGPoint) {
        defer { ghost = nil }
        guard let ghost, canvasFrame.scale > 0 else { return }
        let local = CGPoint(x: (point.x - canvasFrame.origin.x) / canvasFrame.scale,
                            y: (point.y - canvasFrame.origin.y) / canvasFrame.scale)
        // A drop that missed the canvas is a cancelled drag, not a component
        // placed off-screen where it cannot be found again.
        let slack: CGFloat = 40
        guard local.x > -slack, local.y > -slack,
              local.x < document.device.width + slack,
              local.y < document.device.height + slack else { return }
        add(ghost.kind, at: local)
    }

    public func update(_ node: LabNode) {
        var s = screen
        guard let i = s.nodes.firstIndex(where: { $0.id == node.id }) else { return }
        var copy = node
        clamp(&copy)
        s.nodes[i] = copy
        screen = s
    }

    public func move(_ id: UUID, by translation: CGSize) {
        var s = screen
        guard let i = s.nodes.firstIndex(where: { $0.id == id }), !s.nodes[i].locked else { return }
        s.nodes[i].x = snap(s.nodes[i].x + translation.width)
        s.nodes[i].y = snap(s.nodes[i].y + translation.height)
        clamp(&s.nodes[i])
        screen = s
    }

    public func resize(_ id: UUID, by translation: CGSize) {
        var s = screen
        guard let i = s.nodes.firstIndex(where: { $0.id == id }), !s.nodes[i].locked else { return }
        s.nodes[i].width = max(24, snap(s.nodes[i].width + translation.width))
        s.nodes[i].height = max(18, snap(s.nodes[i].height + translation.height))
        clamp(&s.nodes[i])
        screen = s
    }

    public func delete(_ id: UUID) {
        var s = screen
        s.nodes.removeAll { $0.id == id }
        screen = s
        if selection == id { selection = nil }
    }

    public func duplicate(_ id: UUID) {
        guard var node = screen.nodes.first(where: { $0.id == id }) else { return }
        node = LabNode(kind: node.kind, x: node.x + 24, y: node.y + 24).with(from: node)
        var s = screen
        s.nodes.append(node)
        screen = s
        selection = node.id
    }

    public func bringToFront(_ id: UUID) {
        var s = screen
        guard let i = s.nodes.firstIndex(where: { $0.id == id }) else { return }
        let node = s.nodes.remove(at: i)
        s.nodes.append(node)
        screen = s
    }

    public func sendToBack(_ id: UUID) {
        var s = screen
        guard let i = s.nodes.firstIndex(where: { $0.id == id }) else { return }
        let node = s.nodes.remove(at: i)
        s.nodes.insert(node, at: 0)
        screen = s
    }

    /// Align the selection against the canvas — the operation most often
    /// wanted and most tedious by hand.
    public enum Align { case left, centreX, right, top, centreY, bottom }

    public func align(_ id: UUID, _ how: Align) {
        guard var node = screen.nodes.first(where: { $0.id == id }), !node.locked else { return }
        let w = document.device.width, h = document.device.height
        switch how {
        case .left:    node.x = 0
        case .centreX: node.x = snap((w - node.width) / 2)
        case .right:   node.x = snap(w - node.width)
        case .top:     node.y = 0
        case .centreY: node.y = snap((h - node.height) / 2)
        case .bottom:  node.y = snap(h - node.height)
        }
        update(node)
    }

    // MARK: Geometry helpers

    public func snap(_ value: Double) -> Double {
        guard snapToGrid, document.gridStep > 0 else { return value.rounded() }
        return (value / document.gridStep).rounded() * document.gridStep
    }

    private func clamp(_ node: inout LabNode) {
        let w = document.device.width, h = document.device.height
        node.width = min(node.width, w)
        node.height = min(node.height, h)
        // A margin of slack so a component can sit deliberately half off the
        // edge — a rail hanging past the bezel is a real thing to try — but
        // never so far that its body is unreachable.
        node.x = min(max(node.x, -node.width + 40), w - 40)
        node.y = min(max(node.y, -node.height + 30), h - 30)
    }

    public func setDevice(_ device: LabDevice) {
        document.device = device
        for i in document.screens.indices {
            for j in document.screens[i].nodes.indices {
                clamp(&document.screens[i].nodes[j])
            }
        }
        save()
    }

    // MARK: Export and persistence

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

    /// Writes the configuration next to the autosave so it shows up in Files.
    /// Returns the URL, or nil with `lastSaveError` set.
    public func writeExport() -> URL? {
        guard let dir = Self.documentsDirectory else {
            lastSaveError = "No documents directory on this device."
            return nil
        }
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let url = dir.appendingPathComponent("timi-layout-\(stamp).json")
        do {
            try exportJSON().write(to: url, atomically: true, encoding: .utf8)
            lastSaveError = nil
            return url
        } catch {
            lastSaveError = error.localizedDescription
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
        selection = nil
        save()
        return true
    }

    public func resetToSeed() {
        document = LabDocument(device: document.device, screens: LabSeed.screens())
        screenIndex = 0
        selection = nil
        save()
    }

    private static var documentsDirectory: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    }

    private static var autosaveURL: URL? {
        documentsDirectory?.appendingPathComponent("layout-lab.json")
    }

    /// Autosave on every mutation. The work is trivial at this document size
    /// and the alternative — losing an afternoon's layout to a crash — is not.
    public func save() {
        guard let url = Self.autosaveURL else { return }
        do {
            let data = try Self.encoder(pretty: false).encode(document)
            try data.write(to: url, options: .atomic)
            lastSaveError = nil
        } catch {
            lastSaveError = error.localizedDescription
        }
    }

    private static func load() -> LabDocument? {
        guard let url = autosaveURL, let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(LabDocument.self, from: data)
    }
}

private extension LabNode {
    /// Copy the editable properties across, keeping the new identity.
    func with(from other: LabNode) -> LabNode {
        var copy = self
        copy.width = other.width
        copy.height = other.height
        copy.label = other.label
        copy.variant = other.variant
        copy.locked = false
        return copy
    }
}
