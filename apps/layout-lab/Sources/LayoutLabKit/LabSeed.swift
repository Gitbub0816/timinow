import Foundation

/// The screens the app opens with.
///
/// Real Tími screens rather than empty canvases, because a navigation idea is
/// only judgeable against something that looks like the thing it has to
/// navigate. Every one of these is a rough copy of a screen that exists in
/// apps/customer-mobile — laid out for a landscape tablet, which is the shape
/// the current app handles worst.
public enum LabSeed {

    private static func node(_ kind: LabKind, _ x: Double, _ y: Double,
                             _ w: Double? = nil, _ h: Double? = nil,
                             label: String = "", variant: Int = 0) -> LabNode {
        var n = LabNode(kind: kind, x: x, y: y)
        if let w { n.width = w }
        if let h { n.height = h }
        n.label = label
        n.variant = variant
        return n
    }

    public static func screens() -> [LabScreen] {
        [intake(), offers(), tracker(), blank()]
    }

    /// "Tell us about Humphrey" — the screen in the simulator screenshots.
    static func intake() -> LabScreen {
        LabScreen(name: "Intake", nodes: [
            node(.topBar, 0, 0, 1194, 64),
            node(.stepBar, 48, 96, 360, 40, label: "Step 2 of 4"),
            node(.headline, 48, 152, 620, 104, label: "Tell us about Humphrey."),
            node(.bodyText, 48, 268, 620, 56,
                 label: "A little context helps clinics answer faster. Only the species is required."),
            node(.speciesChips, 48, 352, 700, 96),
            node(.textField, 48, 472, 400, 52, label: "Breed \u{2014} optional"),
            node(.pilot, 964, 560, 168, 168),
            node(.primaryButton, 964, 748, 182, 56, label: "Continue"),
            node(.legalNotice, 48, 762, 620, 44)
        ])
    }

    /// Five live offers, which is the screen the whole product exists for.
    static func offers() -> LabScreen {
        LabScreen(name: "Offers", nodes: [
            node(.topBar, 0, 0, 1194, 64, variant: 1),
            node(.countdown, 964, 88, 182, 72),
            node(.headline, 48, 96, 620, 72, label: "Four hospitals can see Humphrey."),
            node(.board, 48, 196, 880, 420, variant: 1),
            node(.actionRail, 964, 400, 182, 220),
            node(.primaryButton, 964, 648, 182, 56, label: "Choose this clinic"),
            node(.statusStrip, 0, 770, 1194, 48,
                 label: "An availability report is not an appointment.")
        ])
    }

    /// En route: the map, the clinic, and the two controls that matter.
    static func tracker() -> LabScreen {
        LabScreen(name: "Tracker", nodes: [
            node(.topBar, 0, 0, 1194, 64),
            node(.mapPlaceholder, 0, 64, 900, 770),
            node(.clinicRow, 932, 96, 230, 92),
            node(.countdown, 932, 212, 230, 72),
            node(.actionRail, 932, 560, 230, 180),
            node(.toast, 240, 104, 420, 56, label: "Bayview is expecting you."),
            node(.fab, 812, 730, 72, 72)
        ])
    }

    static func blank() -> LabScreen {
        LabScreen(name: "Blank", nodes: [])
    }
}
