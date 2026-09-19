import Foundation

// MARK: - Paint

/// A colour, named from the Tími palette or given as a hex literal.
///
/// A token rather than a raw colour, so a component built in the Lab stays on
/// the product's palette by default and a deviation is visible as one — the
/// tool should make the house style the path of least resistance, not police
/// it.
public struct LabPaint: Codable, Hashable, Sendable {
    /// "none", a palette token ("ink", "coral", …), or "custom".
    public var token: String
    /// Used when `token == "custom"`. "#RRGGBB".
    public var hex: String

    public init(_ token: String, hex: String = "#000000") {
        self.token = token
        self.hex = hex
    }

    public static let none  = LabPaint("none")
    public static let ink   = LabPaint("ink")
    public static let paper = LabPaint("paper")
    public static let white = LabPaint("white")
    public static let coral = LabPaint("coral")
    public static let blue  = LabPaint("blue")
    public static let gold  = LabPaint("gold")
    public static let green = LabPaint("green")
    public static let muted = LabPaint("muted")

    public static let tokens = ["none", "ink", "paper", "canvas", "white", "coral", "coralSoft",
                                "blue", "blueSoft", "gold", "goldSoft", "green", "greenSoft",
                                "muted", "custom"]
}

public struct LabEdges: Codable, Hashable, Sendable {
    public var top: Double, leading: Double, bottom: Double, trailing: Double
    public init(_ all: Double = 0) { top = all; leading = all; bottom = all; trailing = all }
    public init(top: Double, leading: Double, bottom: Double, trailing: Double) {
        self.top = top; self.leading = leading; self.bottom = bottom; self.trailing = trailing
    }
    public static let zero = LabEdges(0)
}

// MARK: - Style

/// Everything a primitive can be given.
///
/// One flat struct rather than a per-kind style, because the inspector then
/// has one surface to render and a component can change kind without losing
/// what was set on it.
public struct LabStyle: Codable, Hashable, Sendable {
    // Box
    public var fill = LabPaint.none
    public var stroke = LabPaint.none
    public var strokeWidth: Double = 0
    public var cornerRadius: Double = 0
    /// Hard offset, zero blur — the house treatment. See CLAUDE.md section 7.
    public var shadowOffset: Double = 0
    public var shadow = LabPaint.ink

    // Layout
    /// "h", "v", or "z" — a row, a column, or stacked on top of each other.
    public var axis: String = "h"
    public var spacing: Double = 8
    public var padding = LabEdges.zero
    /// "leading", "center", "trailing" across the axis.
    public var alignment: String = "center"
    /// Fixed size along each dimension; nil means "as big as the content, or
    /// as big as the parent allows if `grow` is set".
    public var fixedWidth: Double?
    public var fixedHeight: Double?
    /// Take all remaining room along the parent's axis.
    public var grow: Bool = false

    // Text
    public var fontSize: Double = 14
    /// 1…9, mapping to ultraLight…black.
    public var fontWeight: Int = 5
    public var serif: Bool = false
    public var tracking: Double = 0
    public var textColor = LabPaint.ink
    /// 0 means "as many lines as it takes".
    public var lineLimit: Int = 0
    /// Shrink rather than truncate, down to this fraction. 1 disables it.
    public var minimumScale: Double = 0.6

    // Whole-element
    public var opacity: Double = 1
    /// Degrees. Applied to this element and everything under it.
    public var rotation: Double = 0

    public init() {}
}

// MARK: - Elements

public enum LabElementKind: String, Codable, CaseIterable, Sendable {
    case stack, box, text, glyph, spacer, divider, dot, capsuleBar

    public var title: String {
        switch self {
        case .stack: return "Stack"
        case .box: return "Box"
        case .text: return "Text"
        case .glyph: return "Icon"
        case .spacer: return "Spacer"
        case .divider: return "Divider"
        case .dot: return "Dot"
        case .capsuleBar: return "Bar"
        }
    }

    public var takesChildren: Bool { self == .stack || self == .box }
}

/// One node in a component's tree.
public struct LabElement: Identifiable, Codable, Hashable, Sendable {
    public var id: UUID
    public var kind: LabElementKind
    public var name: String
    public var text: String
    /// An SF Symbol name for `.glyph`.
    public var symbol: String
    public var style: LabStyle
    public var children: [LabElement]

    public init(_ kind: LabElementKind, name: String = "", text: String = "",
                symbol: String = "circle.fill", style: LabStyle = LabStyle(),
                children: [LabElement] = []) {
        self.id = UUID()
        self.kind = kind
        self.name = name.isEmpty ? kind.title : name
        self.text = text
        self.symbol = symbol
        self.style = style
        self.children = children
    }

    /// Depth-first search, used by the editor to select and mutate in place.
    public func find(_ target: UUID) -> LabElement? {
        if id == target { return self }
        for child in children {
            if let hit = child.find(target) { return hit }
        }
        return nil
    }

    public mutating func replace(_ target: UUID, with element: LabElement) {
        if id == target { self = element; return }
        for i in children.indices { children[i].replace(target, with: element) }
    }

    public mutating func remove(_ target: UUID) {
        children.removeAll { $0.id == target }
        for i in children.indices { children[i].remove(target) }
    }

    public mutating func insert(_ element: LabElement, into parent: UUID) {
        if id == parent { children.append(element); return }
        for i in children.indices { children[i].insert(element, into: parent) }
    }

    /// A fresh identity for every node, so duplicating a component does not
    /// hand two components the same element ids.
    public func reidentified() -> LabElement {
        var copy = self
        copy.id = UUID()
        copy.children = children.map { $0.reidentified() }
        return copy
    }
}

// MARK: - Components and instances

/// A reusable definition. Editing one updates every instance of it on every
/// screen — which is the point: a navigation bar designed once is the same
/// navigation bar everywhere it appears.
public struct LabComponent: Identifiable, Codable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    public var category: String
    public var root: LabElement
    public var defaultWidth: Double
    public var defaultHeight: Double

    public init(name: String, category: String, root: LabElement,
                width: Double, height: Double) {
        self.id = UUID()
        self.name = name
        self.category = category
        self.root = root
        self.defaultWidth = width
        self.defaultHeight = height
    }
}

/// A component placed on a screen.
public struct LabInstance: Identifiable, Codable, Hashable, Sendable {
    public var id: UUID
    public var componentID: UUID
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    /// Degrees, clockwise. Orientation is per placement, not per component:
    /// the same rail is a side rail at 90° and a tab bar at 0°.
    public var rotation: Double
    public var locked: Bool
    /// Replaces the first text node's content. Empty keeps the component's.
    public var overrideText: String
    /// Scale the whole component to the frame instead of letting it lay out.
    public var scaleToFit: Bool

    public init(componentID: UUID, x: Double, y: Double, width: Double, height: Double) {
        self.id = UUID()
        self.componentID = componentID
        self.x = x; self.y = y; self.width = width; self.height = height
        self.rotation = 0
        self.locked = false
        self.overrideText = ""
        self.scaleToFit = false
    }

    public var frame: LabRect {
        LabRect(x: x, y: y, width: width, height: height)
    }
}

public struct LabRect: Hashable, Sendable {
    public var x: Double, y: Double, width: Double, height: Double
    public var minX: Double { x }
    public var maxX: Double { x + width }
    public var midX: Double { x + width / 2 }
    public var minY: Double { y }
    public var maxY: Double { y + height }
    public var midY: Double { y + height / 2 }
}

public struct LabScreen: Identifiable, Codable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    public var instances: [LabInstance]
    public init(name: String, instances: [LabInstance] = []) {
        self.id = UUID(); self.name = name; self.instances = instances
    }
}

// MARK: - Device and reach

/// A canvas, in points *and* in millimetres.
///
/// Both, because they answer different questions and the second one was
/// missing. Points decide layout; millimetres decide whether a thumb can get
/// there. A reach arc drawn as a fraction of the screen — which is what the
/// first version of this app did — says a 13-inch iPad is as reachable as a
/// phone, which is the opposite of true.
///
/// The physical figures are editable and default to zero for anything not
/// measured, because inventing a millimetre size for a device nobody here has
/// held is how the arc got wrong in the first place. `LabRuler` in the canvas
/// draws a real 50mm scale so a physical ruler held against the screen
/// calibrates it in about ten seconds.
public struct LabDevice: Codable, Hashable, Sendable {
    public var name: String
    public var pointWidth: Double
    public var pointHeight: Double
    public var physicalWidthMM: Double
    public var physicalHeightMM: Double

    public init(name: String, pointWidth: Double, pointHeight: Double,
                physicalWidthMM: Double, physicalHeightMM: Double) {
        self.name = name
        self.pointWidth = pointWidth
        self.pointHeight = pointHeight
        self.physicalWidthMM = physicalWidthMM
        self.physicalHeightMM = physicalHeightMM
    }

    /// Points per millimetre, from the width. Zero when unmeasured, which the
    /// canvas reads as "do not draw a reach arc you cannot justify".
    public var pointsPerMM: Double {
        physicalWidthMM > 0 ? pointWidth / physicalWidthMM : 0
    }

    public var isMeasured: Bool { physicalWidthMM > 0 && physicalHeightMM > 0 }

    public static let presets: [LabDevice] = [
        // Physical sizes left at zero deliberately: every figure here would be
        // recalled rather than measured, and a confidently wrong millimetre
        // value is worse than an obviously missing one. Measure with the
        // ruler overlay, then save the number into the preset.
        LabDevice(name: "Fold, open", pointWidth: 1000, pointHeight: 703,
                  physicalWidthMM: 0, physicalHeightMM: 0),
        LabDevice(name: "Fold, closed", pointWidth: 393, pointHeight: 852,
                  physicalWidthMM: 0, physicalHeightMM: 0),
        LabDevice(name: "iPad 11\u{2033} landscape", pointWidth: 1194, pointHeight: 834,
                  physicalWidthMM: 0, physicalHeightMM: 0),
        LabDevice(name: "iPad 11\u{2033} portrait", pointWidth: 834, pointHeight: 1194,
                  physicalWidthMM: 0, physicalHeightMM: 0),
        LabDevice(name: "iPhone", pointWidth: 393, pointHeight: 852,
                  physicalWidthMM: 0, physicalHeightMM: 0)
    ]
}

/// The hand, in millimetres.
public struct LabReach: Codable, Hashable, Sendable {
    public var show: Bool = true
    /// "right", "left", "centre".
    public var hand: String = "right"
    /// Comfortable sweep from the pivot. An adult thumb's functional reach is
    /// commonly taken as somewhere around 75–95mm; it is a setting rather
    /// than a constant because hands differ by more than designs usually
    /// admit, and because the whole point is to test against a real one.
    public var comfortableMM: Double = 85
    /// The furthest a thumb goes with the grip shifting — still usable, but
    /// not while holding an animal.
    public var stretchMM: Double = 110
    /// How far in from the bottom corner the base of the thumb sits.
    public var pivotInsetMM: Double = 14
    public var pivotBottomMM: Double = 6

    public init() {}
}

// MARK: - The document

public struct LabDocument: Codable, Sendable {
    public var version: Int
    public var exportedAt: Date
    public var device: LabDevice
    public var reach: LabReach
    public var gridStep: Double
    /// The shared library. Screens hold instances that point in here.
    public var components: [LabComponent]
    public var screens: [LabScreen]

    public static let currentVersion = 2

    public init(device: LabDevice, components: [LabComponent], screens: [LabScreen]) {
        self.version = Self.currentVersion
        self.exportedAt = Date()
        self.device = device
        self.reach = LabReach()
        self.gridStep = 8
        self.components = components
        self.screens = screens
    }

    public func component(_ id: UUID) -> LabComponent? {
        components.first { $0.id == id }
    }
}
