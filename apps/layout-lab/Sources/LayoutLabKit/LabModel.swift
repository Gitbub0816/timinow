import Foundation

// MARK: - The catalogue

/// Every component that can be placed on a screen.
///
/// The navigation cases are the point of the app: thirty ways of getting from
/// one place to another, so a layout can be tried with each rather than
/// argued about. The content cases exist so a navigation idea can be judged
/// against something that looks like a real screen instead of grey boxes.
///
/// The raw values are the export format's vocabulary, so renaming a case
/// breaks every saved configuration. Add cases; do not rename them.
public enum LabKind: String, Codable, CaseIterable, Sendable {

    // ── Navigation · bars and rails ──────────────────────────────────────
    case topBar, bottomTabs, tabsWithCentre, sideRail, floatingPill, toolbar, sidebarList

    // ── Navigation · moving between things ───────────────────────────────
    case backButton, breadcrumb, navMenu, searchField, segmented, chipRow

    // ── Navigation · showing where you are ───────────────────────────────
    case progressDots, stepBar, pageDots, statusStrip

    // ── Navigation · thumb-first ─────────────────────────────────────────
    case pilot, deck, board, radialDial, thumbArc, actionRail, fab, speedDial

    // ── Navigation · surfaces that arrive ────────────────────────────────
    case bottomSheet, modalCard, sheetGrabber, splitDivider, toast, drawerHandle

    // ── Content ──────────────────────────────────────────────────────────
    case wordmark, headline, bodyText, textField, primaryButton, quietButton
    case speciesChips, offerCard, clinicRow, mapPlaceholder, countdown
    case priceRow, legalNotice, petAvatar

    public enum Group: String, CaseIterable, Sendable {
        case bars = "Bars & rails"
        case moving = "Moving between"
        case position = "Where you are"
        case thumb = "Thumb-first"
        case surfaces = "Surfaces"
        case content = "Content"
    }

    public var group: Group {
        switch self {
        case .topBar, .bottomTabs, .tabsWithCentre, .sideRail, .floatingPill, .toolbar, .sidebarList:
            return .bars
        case .backButton, .breadcrumb, .navMenu, .searchField, .segmented, .chipRow:
            return .moving
        case .progressDots, .stepBar, .pageDots, .statusStrip:
            return .position
        case .pilot, .deck, .board, .radialDial, .thumbArc, .actionRail, .fab, .speedDial:
            return .thumb
        case .bottomSheet, .modalCard, .sheetGrabber, .splitDivider, .toast, .drawerHandle:
            return .surfaces
        default:
            return .content
        }
    }

    public var title: String {
        switch self {
        case .topBar: return "Top bar"
        case .bottomTabs: return "Tab bar"
        case .tabsWithCentre: return "Tabs, centre action"
        case .sideRail: return "Side rail"
        case .floatingPill: return "Floating pill"
        case .toolbar: return "Toolbar"
        case .sidebarList: return "Sidebar list"
        case .backButton: return "Back"
        case .breadcrumb: return "Breadcrumb"
        case .navMenu: return "Menu button"
        case .searchField: return "Search"
        case .segmented: return "Segmented"
        case .chipRow: return "Chip row"
        case .progressDots: return "Progress dots"
        case .stepBar: return "Step bar"
        case .pageDots: return "Page dots"
        case .statusStrip: return "Status strip"
        case .pilot: return "Pilot"
        case .deck: return "Deck"
        case .board: return "Board"
        case .radialDial: return "Radial dial"
        case .thumbArc: return "Thumb arc"
        case .actionRail: return "Action rail"
        case .fab: return "Floating action"
        case .speedDial: return "Speed dial"
        case .bottomSheet: return "Bottom sheet"
        case .modalCard: return "Modal card"
        case .sheetGrabber: return "Grabber"
        case .splitDivider: return "Split divider"
        case .toast: return "Toast"
        case .drawerHandle: return "Drawer handle"
        case .wordmark: return "Wordmark"
        case .headline: return "Headline"
        case .bodyText: return "Body text"
        case .textField: return "Text field"
        case .primaryButton: return "Primary button"
        case .quietButton: return "Quiet button"
        case .speciesChips: return "Species chips"
        case .offerCard: return "Offer card"
        case .clinicRow: return "Clinic row"
        case .mapPlaceholder: return "Map"
        case .countdown: return "Countdown"
        case .priceRow: return "Price row"
        case .legalNotice: return "Legal notice"
        case .petAvatar: return "Pet avatar"
        }
    }

    /// One line in the library, so the twenty-odd navigation options can be
    /// told apart without placing each one to find out.
    public var blurb: String {
        switch self {
        case .topBar: return "Wordmark, title, one action."
        case .bottomTabs: return "Four destinations, always visible."
        case .tabsWithCentre: return "Four tabs around a raised primary action."
        case .sideRail: return "Vertical destinations down one edge."
        case .floatingPill: return "Detached rounded bar over the content."
        case .toolbar: return "A row of icon-only actions."
        case .sidebarList: return "A full column of destinations with labels."
        case .backButton: return "One step back, with the parent named."
        case .breadcrumb: return "The whole path, each part tappable."
        case .navMenu: return "One button that opens everything else."
        case .searchField: return "Jump anywhere by typing."
        case .segmented: return "Two to four peers, one visible at a time."
        case .chipRow: return "Scrollable filters, multi-select."
        case .progressDots: return "Where you are in a fixed sequence."
        case .stepBar: return "Step 2 of 4, with a filled track."
        case .pageDots: return "Position within a carousel."
        case .statusStrip: return "A persistent line of state or warning."
        case .pilot: return "A miniature of the screen you drag a cursor in."
        case .deck: return "A snapping horizontal strip you sweep."
        case .board: return "Everything at once, as a grid."
        case .radialDial: return "An arc of options around the thumb."
        case .thumbArc: return "Actions laid along the natural sweep."
        case .actionRail: return "Stacked buttons pinned to one side."
        case .fab: return "One action, floating, always reachable."
        case .speedDial: return "A floating action that fans out."
        case .bottomSheet: return "Content that rises from the bottom edge."
        case .modalCard: return "A card over a dimmed screen."
        case .sheetGrabber: return "The handle that says a sheet can be dragged."
        case .splitDivider: return "The seam between two panes."
        case .toast: return "A message that leaves on its own."
        case .drawerHandle: return "An edge grip that pulls a panel out."
        case .wordmark: return "Tími NOW."
        case .headline: return "The question the screen is asking."
        case .bodyText: return "A paragraph of supporting copy."
        case .textField: return "One line of typed input."
        case .primaryButton: return "The coral one. Usually Continue."
        case .quietButton: return "The secondary action."
        case .speciesChips: return "Dog, cat, rabbit, bird, reptile, other."
        case .offerCard: return "One clinic's live offer."
        case .clinicRow: return "A clinic in a list, with distance."
        case .mapPlaceholder: return "Where the map goes."
        case .countdown: return "Time left in the search."
        case .priceRow: return "A fee, itemised."
        case .legalNotice: return "The not-veterinary-advice line."
        case .petAvatar: return "The pet's circle."
        }
    }

    /// Size a component arrives at. Chosen to look right on a tablet-width
    /// canvas; everything is resizable afterwards.
    public var defaultSize: LabSize {
        switch self {
        case .topBar, .statusStrip, .toast, .breadcrumb, .splitDivider:
            return LabSize(width: 720, height: 56)
        case .bottomTabs, .tabsWithCentre, .toolbar, .floatingPill:
            return LabSize(width: 520, height: 78)
        case .sideRail:               return LabSize(width: 92, height: 460)
        case .sidebarList:            return LabSize(width: 240, height: 460)
        case .backButton, .navMenu:   return LabSize(width: 120, height: 48)
        case .searchField, .textField: return LabSize(width: 340, height: 52)
        case .segmented:              return LabSize(width: 320, height: 46)
        case .chipRow:                return LabSize(width: 480, height: 48)
        case .progressDots, .pageDots: return LabSize(width: 140, height: 24)
        case .stepBar:                return LabSize(width: 360, height: 40)
        case .pilot:                  return LabSize(width: 168, height: 168)
        case .deck:                   return LabSize(width: 640, height: 120)
        case .board:                  return LabSize(width: 560, height: 320)
        case .radialDial, .thumbArc:  return LabSize(width: 240, height: 240)
        case .actionRail:             return LabSize(width: 180, height: 220)
        case .fab:                    return LabSize(width: 72, height: 72)
        case .speedDial:              return LabSize(width: 96, height: 260)
        case .bottomSheet:            return LabSize(width: 720, height: 280)
        case .modalCard:              return LabSize(width: 420, height: 260)
        case .sheetGrabber, .drawerHandle: return LabSize(width: 80, height: 18)
        case .wordmark:               return LabSize(width: 180, height: 48)
        case .headline:               return LabSize(width: 520, height: 96)
        case .bodyText, .legalNotice: return LabSize(width: 480, height: 64)
        case .primaryButton, .quietButton: return LabSize(width: 260, height: 56)
        case .speciesChips:           return LabSize(width: 560, height: 92)
        case .offerCard:              return LabSize(width: 300, height: 180)
        case .clinicRow:              return LabSize(width: 460, height: 76)
        case .mapPlaceholder:         return LabSize(width: 520, height: 320)
        case .countdown:              return LabSize(width: 200, height: 72)
        case .priceRow:               return LabSize(width: 380, height: 44)
        case .petAvatar:              return LabSize(width: 96, height: 96)
        }
    }

    /// How many looks this component has. The inspector cycles through them.
    public var variantCount: Int {
        switch self {
        case .bottomTabs, .segmented, .board, .deck, .actionRail, .chipRow: return 3
        case .topBar, .pilot, .offerCard, .stepBar, .floatingPill, .radialDial: return 2
        default: return 1
        }
    }
}

// MARK: - Geometry, as plain Codable values

public struct LabSize: Codable, Hashable, Sendable {
    public var width: Double
    public var height: Double
    public init(width: Double, height: Double) { self.width = width; self.height = height }
}

/// One placed component.
///
/// Frames are in points, in the canvas's own coordinates, origin top-left —
/// the same numbers a SwiftUI `.frame` and `.offset` would take, so an
/// exported configuration reads as instructions rather than as data needing
/// a translation layer.
public struct LabNode: Identifiable, Codable, Hashable, Sendable {
    public var id: UUID
    public var kind: LabKind
    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double
    /// Overrides the component's own default copy. Empty means "use default".
    public var label: String
    public var variant: Int
    public var locked: Bool

    public init(kind: LabKind, x: Double, y: Double) {
        self.id = UUID()
        self.kind = kind
        self.x = x
        self.y = y
        self.width = kind.defaultSize.width
        self.height = kind.defaultSize.height
        self.label = ""
        self.variant = 0
        self.locked = false
    }
}

public struct LabScreen: Identifiable, Codable, Hashable, Sendable {
    public var id: UUID
    public var name: String
    public var nodes: [LabNode]

    public init(name: String, nodes: [LabNode] = []) {
        self.id = UUID()
        self.name = name
        self.nodes = nodes
    }
}

/// Canvas size. Editable rather than a closed enum of devices, because
/// inventing a point size for a device nobody here has measured is worse than
/// letting you type the one you actually observed.
public struct LabDevice: Codable, Hashable, Sendable {
    public var name: String
    public var width: Double
    public var height: Double

    public init(name: String, width: Double, height: Double) {
        self.name = name; self.width = width; self.height = height
    }

    public static let presets: [LabDevice] = [
        LabDevice(name: "iPad 11\u{2033} landscape", width: 1194, height: 834),
        LabDevice(name: "iPad 11\u{2033} portrait", width: 834, height: 1194),
        LabDevice(name: "iPad 13\u{2033} landscape", width: 1366, height: 1024),
        LabDevice(name: "iPhone", width: 393, height: 852),
        // Taken from a screenshot of the Duo simulator at 2000x1406 px,
        // halved for a @2x scale. Not from a spec sheet — adjust it once the
        // real figure is known, which is exactly why this is editable.
        LabDevice(name: "Fold, open (measured)", width: 1000, height: 703)
    ]
}

// MARK: - The document

/// What "export a configuration" produces.
///
/// Deliberately boring: a version, a canvas, and a list of frames. It is the
/// kind of file another tool — or a future `TimiReachLayout` — can read
/// without needing this app to be running or even installed.
public struct LabDocument: Codable, Sendable {
    public var version: Int
    public var exportedAt: Date
    public var device: LabDevice
    public var handedness: String
    public var gridStep: Double
    public var screens: [LabScreen]

    public static let currentVersion = 1

    public init(device: LabDevice, screens: [LabScreen]) {
        self.version = Self.currentVersion
        self.exportedAt = Date()
        self.device = device
        self.handedness = "right"
        self.gridStep = 8
        self.screens = screens
    }
}
