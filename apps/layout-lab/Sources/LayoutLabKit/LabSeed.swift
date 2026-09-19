import Foundation

/// The starting library.
///
/// Every one of these is built from the same primitives you get in the
/// component editor — there is no privileged set. Open any of them, take it
/// apart, and the thing you end up with is as real as the thing you started
/// from. That is the difference between a palette of pictures and a palette
/// of components.
public enum LabSeed {

    // MARK: Builders

    static func st(_ build: (inout LabStyle) -> Void) -> LabStyle {
        var s = LabStyle()
        build(&s)
        return s
    }

    static func row(_ spacing: Double, _ pad: Double, _ children: [LabElement],
                    align: String = "center") -> LabElement {
        LabElement(.stack, name: "Row", style: st {
            $0.axis = "h"; $0.spacing = spacing; $0.padding = LabEdges(pad)
            $0.alignment = align; $0.grow = true
        }, children: children)
    }

    static func col(_ spacing: Double, _ pad: Double, _ children: [LabElement],
                    align: String = "center") -> LabElement {
        LabElement(.stack, name: "Column", style: st {
            $0.axis = "v"; $0.spacing = spacing; $0.padding = LabEdges(pad)
            $0.alignment = align; $0.grow = true
        }, children: children)
    }

    static func card(_ fill: LabPaint, radius: Double, shadow: Double,
                     _ children: [LabElement], axis: String = "h",
                     spacing: Double = 10, pad: Double = 12) -> LabElement {
        LabElement(.box, name: "Card", style: st {
            $0.axis = axis; $0.spacing = spacing; $0.padding = LabEdges(pad)
            $0.fill = fill; $0.stroke = .ink; $0.strokeWidth = 2
            $0.cornerRadius = radius; $0.shadowOffset = shadow; $0.grow = true
        }, children: children)
    }

    static func label(_ text: String, _ size: Double, _ weight: Int,
                      _ colour: LabPaint = .ink, serif: Bool = false,
                      tracking: Double = 0, lines: Int = 1) -> LabElement {
        LabElement(.text, name: "Text", text: text, style: st {
            $0.fontSize = size; $0.fontWeight = weight; $0.textColor = colour
            $0.serif = serif; $0.tracking = tracking; $0.lineLimit = lines
        })
    }

    static func icon(_ symbol: String, _ size: Double, _ colour: LabPaint = .ink) -> LabElement {
        LabElement(.glyph, name: "Icon", symbol: symbol, style: st {
            $0.fontSize = size; $0.fontWeight = 7; $0.textColor = colour
        })
    }

    static func spacer() -> LabElement {
        LabElement(.spacer, style: st { $0.grow = true })
    }

    static func dot(_ size: Double, _ colour: LabPaint) -> LabElement {
        LabElement(.dot, style: st { $0.fill = colour; $0.fixedWidth = size; $0.fixedHeight = size })
    }

    static func bar(_ w: Double, _ h: Double, _ colour: LabPaint) -> LabElement {
        LabElement(.capsuleBar, style: st { $0.fill = colour; $0.fixedWidth = w; $0.fixedHeight = h })
    }

    static func pill(_ text: String, _ fill: LabPaint, _ textColour: LabPaint) -> LabElement {
        LabElement(.box, name: "Pill", style: st {
            $0.axis = "h"; $0.padding = LabEdges(top: 7, leading: 14, bottom: 7, trailing: 14)
            $0.fill = fill; $0.stroke = .ink; $0.strokeWidth = 1.5; $0.cornerRadius = 999
        }, children: [label(text, 12, 7, textColour)])
    }

    static func tab(_ symbol: String, _ title: String, _ on: Bool) -> LabElement {
        LabElement(.stack, name: "Tab", style: st {
            $0.axis = "v"; $0.spacing = 4; $0.alignment = "center"; $0.grow = true
        }, children: [
            icon(symbol, 18, on ? .blue : .muted),
            label(title, 10, on ? 9 : 6, on ? .ink : .muted)
        ])
    }

    // MARK: The library

    public static func components() -> [LabComponent] {
        var out: [LabComponent] = []

        func add(_ name: String, _ category: String, _ w: Double, _ h: Double, _ root: LabElement) {
            out.append(LabComponent(name: name, category: category, root: root, width: w, height: h))
        }

        // ── Bars and rails ───────────────────────────────────────────────
        add("Top bar", "Bars", 720, 64, row(12, 16, [
            row(2, 0, [label("T\u{ED}mi", 20, 9, .blue, serif: true),
                       label("NOW", 9, 9, .coral, tracking: 1)]),
            spacer(),
            pill("Sign in", .white, .blue)
        ]))

        add("Tab bar", "Bars", 520, 78, LabElement(.box, name: "Tab bar", style: st {
            $0.axis = "h"; $0.spacing = 0; $0.padding = LabEdges(top: 10, leading: 8, bottom: 10, trailing: 8)
            $0.fill = .paper; $0.stroke = .ink; $0.strokeWidth = 2; $0.cornerRadius = 16; $0.grow = true
        }, children: [
            tab("magnifyingglass", "Find", true), tab("pawprint.fill", "Pets", false),
            tab("clock.fill", "Activity", false), tab("gearshape.fill", "Settings", false)
        ]))

        // Same tree, vertical axis. Rotating a tab bar is not the same as
        // designing a rail, so the rail is its own component — but it is the
        // identical children with one property changed, which is the point.
        add("Side rail", "Bars", 96, 420, LabElement(.box, name: "Side rail", style: st {
            $0.axis = "v"; $0.spacing = 18; $0.padding = LabEdges(16)
            $0.fill = .paper; $0.stroke = .ink; $0.strokeWidth = 2; $0.cornerRadius = 16; $0.grow = true
        }, children: [
            tab("magnifyingglass", "Find", true), tab("pawprint.fill", "Pets", false),
            tab("clock.fill", "Log", false), spacer(), tab("gearshape.fill", "You", false)
        ]))

        add("Floating pill", "Bars", 340, 62, LabElement(.box, name: "Pill bar", style: st {
            $0.axis = "h"; $0.spacing = 6; $0.padding = LabEdges(6)
            $0.fill = .white; $0.stroke = .ink; $0.strokeWidth = 2
            $0.cornerRadius = 999; $0.shadowOffset = 4; $0.grow = true
        }, children: [
            pill("Find", .ink, .white), pill("Pets", .none, .ink), pill("Activity", .none, .ink)
        ]))

        add("Toolbar", "Bars", 300, 56, row(10, 8, [
            icon("arrow.left", 17), icon("plus.circle", 17),
            icon("gearshape", 17), icon("flag", 17), icon("ellipsis", 17)
        ]))

        // ── Moving between ───────────────────────────────────────────────
        add("Back", "Moving", 130, 48, card(.white, radius: 12, shadow: 0, [
            icon("arrow.left", 16), label("Back", 14, 7)
        ]))

        add("Search", "Moving", 340, 52, card(.white, radius: 12, shadow: 2, [
            icon("magnifyingglass", 16, .muted), label("Search clinics", 14, 4, .muted), spacer()
        ]))

        add("Segmented", "Moving", 320, 46, LabElement(.box, name: "Segmented", style: st {
            $0.axis = "h"; $0.spacing = 0; $0.stroke = .ink; $0.strokeWidth = 2
            $0.cornerRadius = 12; $0.grow = true
        }, children: [
            LabElement(.box, name: "On", style: st {
                $0.fill = .ink; $0.grow = true; $0.padding = LabEdges(9)
            }, children: [label("Urgent", 13, 7, .white)]),
            LabElement(.box, name: "Off", style: st {
                $0.fill = .white; $0.grow = true; $0.padding = LabEdges(9)
            }, children: [label("Routine", 13, 7)]),
            LabElement(.box, name: "Off", style: st {
                $0.fill = .white; $0.grow = true; $0.padding = LabEdges(9)
            }, children: [label("Advice", 13, 7)])
        ]))

        add("Chip row", "Moving", 460, 44, row(8, 0, [
            pill("Open now", .blue, .white), pill("Emergency", .white, .ink),
            pill("Under 15 min", .white, .ink), spacer()
        ]))

        // ── Where you are ────────────────────────────────────────────────
        add("Progress dots", "Position", 150, 24, row(9, 0, [
            dot(10, .muted), bar(28, 10, .coral), dot(10, .muted), dot(10, .muted), spacer()
        ]))

        add("Step bar", "Position", 360, 44, col(6, 0, [
            label("STEP 2 OF 4", 11, 9, .muted, tracking: 1.2),
            LabElement(.box, name: "Track", style: st {
                $0.axis = "h"; $0.spacing = 0; $0.fill = .canvas
                $0.cornerRadius = 999; $0.fixedHeight = 8; $0.grow = true
            }, children: [
                bar(140, 8, .coral), spacer()
            ])
        ], align: "leading"))

        add("Status strip", "Position", 720, 48, LabElement(.box, name: "Strip", style: st {
            $0.axis = "h"; $0.spacing = 10; $0.padding = LabEdges(top: 12, leading: 16, bottom: 12, trailing: 16)
            $0.fill = .goldSoft; $0.grow = true
        }, children: [
            icon("exclamationmark.triangle.fill", 14),
            label("T\u{ED}mi is not a veterinary practice and does not give medical advice.", 12, 6),
            spacer()
        ]))

        // ── Thumb-first ──────────────────────────────────────────────────
        add("Pilot", "Thumb", 168, 168, LabElement(.box, name: "Pilot", style: st {
            $0.axis = "v"; $0.spacing = 6; $0.padding = LabEdges(9)
            $0.fill = .paper; $0.stroke = .ink; $0.strokeWidth = 2
            $0.cornerRadius = 16; $0.shadowOffset = 4; $0.grow = true
        }, children: [
            LabElement(.stack, name: "Grid", style: st {
                $0.axis = "v"; $0.spacing = 4; $0.grow = true
            }, children: [
                row(4, 0, [miniCell(false), miniCell(true), miniCell(false)]),
                row(4, 0, [miniCell(false), miniCell(false), miniCell(false)])
            ]),
            label("PILOT", 8, 9, .muted, tracking: 1.4)
        ]))

        add("Action rail", "Thumb", 180, 200, col(8, 0, [
            spacer(),
            quiet("Call"), quiet("Navigate"), primary("Continue")
        ]))

        add("Primary button", "Thumb", 240, 54, primary("Continue"))
        add("Quiet button", "Thumb", 240, 46, quiet("Not now"))

        add("Floating action", "Thumb", 72, 72, LabElement(.box, name: "FAB", style: st {
            $0.axis = "z"; $0.fill = .coral; $0.stroke = .ink; $0.strokeWidth = 2
            $0.cornerRadius = 999; $0.shadowOffset = 4; $0.grow = true
        }, children: [icon("arrow.right", 24, .white)]))

        // ── Surfaces ─────────────────────────────────────────────────────
        add("Modal card", "Surfaces", 400, 240, card(.white, radius: 20, shadow: 6, [
            label("Leave this search?", 17, 9),
            label("Clinics are still answering. Leaving cancels it.", 12, 4, .muted, lines: 2),
            spacer(), primary("Stay"), quiet("Leave")
        ], axis: "v", spacing: 10, pad: 16))

        add("Toast", "Surfaces", 420, 56, card(.white, radius: 14, shadow: 3, [
            dot(9, .green), label("Bayview is expecting you.", 13, 7), spacer(),
            icon("xmark", 14, .muted)
        ]))

        add("Grabber", "Surfaces", 80, 18, LabElement(.box, name: "Grabber", style: st {
            $0.axis = "z"; $0.grow = true
        }, children: [bar(52, 6, .muted)]))

        // ── Content ──────────────────────────────────────────────────────
        add("Headline", "Content", 520, 92,
            label("Tell us about Humphrey.", 34, 9, .ink, serif: true, lines: 2))

        add("Body text", "Content", 480, 60,
            label("A little context helps clinics answer faster. Only the species is required.",
                  14, 4, .muted, lines: 3))

        add("Text field", "Content", 340, 52, card(.white, radius: 14, shadow: 3, [
            label("Pet\u{2019}s name", 15, 4, .muted), spacer()
        ]))

        add("Offer card", "Content", 300, 190, card(.white, radius: 18, shadow: 4, [
            label("12 MIN AWAY", 11, 9, .coral, tracking: 1),
            label("Bayview Animal Hospital", 16, 9, .ink, lines: 2),
            label("Reported capacity 40 seconds ago", 11, 4, .muted),
            spacer(), primary("Choose")
        ], axis: "v", spacing: 6, pad: 14))

        add("Clinic row", "Content", 460, 76, card(.white, radius: 16, shadow: 3, [
            LabElement(.box, name: "Rank", style: st {
                $0.axis = "z"; $0.fill = .blue; $0.cornerRadius = 999
                $0.fixedWidth = 30; $0.fixedHeight = 30
            }, children: [label("1", 14, 9, .white)]),
            col(2, 0, [
                label("Bayview Animal Hospital", 14, 7),
                label("Address shown on confirmation", 11, 4, .muted)
            ], align: "leading"),
            spacer(),
            label("12\u{2032}", 14, 9)
        ]))

        add("Countdown", "Content", 200, 72, card(.goldSoft, radius: 14, shadow: 3, [
            label("0:47", 30, 9),
            label("LEFT TO ANSWER", 8, 9, .muted, tracking: 1.4)
        ], axis: "v", spacing: 2, pad: 8))

        add("Pet avatar", "Content", 96, 96, LabElement(.box, name: "Avatar", style: st {
            $0.axis = "z"; $0.fill = .goldSoft; $0.stroke = .ink; $0.strokeWidth = 2
            $0.cornerRadius = 999; $0.grow = true
        }, children: [label("H", 38, 9)]))

        return out
    }

    static func miniCell(_ on: Bool) -> LabElement {
        LabElement(.box, name: "Cell", style: st {
            $0.fill = on ? .gold : .white
            $0.stroke = on ? .ink : .muted
            $0.strokeWidth = 1.5; $0.cornerRadius = 5; $0.grow = true
        })
    }

    static func primary(_ title: String) -> LabElement {
        LabElement(.box, name: "Primary", style: st {
            $0.axis = "z"; $0.padding = LabEdges(top: 12, leading: 18, bottom: 12, trailing: 18)
            $0.fill = .coral; $0.stroke = .ink; $0.strokeWidth = 2
            $0.cornerRadius = 14; $0.shadowOffset = 3; $0.grow = true
        }, children: [label(title, 15, 9, .white)])
    }

    static func quiet(_ title: String) -> LabElement {
        LabElement(.box, name: "Quiet", style: st {
            $0.axis = "z"; $0.padding = LabEdges(top: 10, leading: 16, bottom: 10, trailing: 16)
            $0.fill = .white; $0.stroke = .muted; $0.strokeWidth = 1.5
            $0.cornerRadius = 13; $0.grow = true
        }, children: [label(title, 14, 7)])
    }

    // MARK: Screens

    public static func screens(_ components: [LabComponent]) -> [LabScreen] {
        func id(_ name: String) -> UUID? { components.first { $0.name == name }?.id }
        func place(_ name: String, _ x: Double, _ y: Double,
                   _ w: Double? = nil, _ h: Double? = nil) -> LabInstance? {
            guard let cid = id(name), let c = components.first(where: { $0.id == cid }) else { return nil }
            return LabInstance(componentID: cid, x: x, y: y,
                               width: w ?? c.defaultWidth, height: h ?? c.defaultHeight)
        }

        let intake = [place("Top bar", 0, 0, 1000, 64), place("Step bar", 40, 92),
                      place("Headline", 40, 148), place("Body text", 40, 256),
                      place("Pilot", 790, 420), place("Primary button", 750, 610, 210, 54),
                      place("Status strip", 0, 655, 1000, 48)].compactMap { $0 }

        let offers = [place("Top bar", 0, 0, 1000, 64), place("Countdown", 790, 90),
                      place("Headline", 40, 90, 700, 76),
                      place("Offer card", 40, 200), place("Offer card", 360, 200),
                      place("Action rail", 790, 300), place("Status strip", 0, 655, 1000, 48)]
                     .compactMap { $0 }

        return [
            LabScreen(name: "Intake", instances: intake),
            LabScreen(name: "Offers", instances: offers),
            LabScreen(name: "Blank")
        ]
    }
}
