import Foundation
import SwiftUI

/// Draws a placed component.
///
/// Every case fills the frame it is given rather than sizing itself, so
/// resizing is meaningful for all of them — a tab bar stretched to 1200pt
/// spreads its tabs, it does not sit in the middle at its natural width.
///
/// The switch is split by group. One 44-case `@ViewBuilder` is exactly the
/// shape that makes the Swift type-checker give up ("unable to type-check
/// this expression in reasonable time"), and the split costs nothing.
public struct LabComponentView: View {
    public var node: LabNode
    public init(node: LabNode) { self.node = node }

    private var text: String { node.label.isEmpty ? node.kind.title : node.label }

    public var body: some View {
        Group {
            switch node.kind.group {
            case .bars:      bars
            case .moving:    moving
            case .position:  position
            case .thumb:     thumb
            case .surfaces:  surfaces
            case .content:   content
            }
        }
        .frame(width: node.width, height: node.height)
        .clipped()
    }

    // MARK: Bars and rails

    @ViewBuilder private var bars: some View {
        switch node.kind {
        case .topBar:
            HStack(spacing: 12) {
                LabWordmark()
                if node.variant == 1 {
                    Text(node.label.isEmpty ? "Live offers" : node.label)
                        .font(.system(size: 15, weight: .bold)).foregroundStyle(LabColor.ink)
                }
                Spacer()
                LabPill(text: "Sign in")
            }
            .padding(.horizontal, 18)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(LabColor.paper)
            .overlay(Rectangle().frame(height: 2).foregroundStyle(LabColor.ink), alignment: .bottom)

        case .bottomTabs:
            HStack(spacing: 0) {
                ForEach(["Find", "Pets", "Activity", "Settings"], id: \.self) { title in
                    LabTabItem(title: title, on: title == "Find", style: node.variant)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labPanel(node.variant == 2 ? .white : LabColor.paper)

        case .tabsWithCentre:
            ZStack {
                HStack(spacing: 0) {
                    ForEach(["Find", "Pets", "", "Activity", "Settings"], id: \.self) { title in
                        if title.isEmpty { Spacer().frame(maxWidth: .infinity) }
                        else { LabTabItem(title: title, on: title == "Find", style: 0).frame(maxWidth: .infinity) }
                    }
                }
                .padding(.horizontal, 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .labPanel()
                Circle().fill(LabColor.coral)
                    .overlay(Circle().stroke(LabColor.ink, lineWidth: 2))
                    .overlay(Text("+").font(.system(size: 26, weight: .black)).foregroundStyle(.white))
                    .frame(width: min(node.height * 0.92, 64), height: min(node.height * 0.92, 64))
                    .offset(y: -node.height * 0.28)
            }

        case .sideRail:
            VStack(spacing: 14) {
                ForEach(["Find", "Pets", "Log", "You"], id: \.self) { title in
                    LabTabItem(title: title, on: title == "Find", style: 0)
                }
                Spacer()
            }
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labPanel()

        case .floatingPill:
            HStack(spacing: 6) {
                ForEach(["Find", "Pets", "Activity"], id: \.self) { title in
                    Text(title).font(.system(size: 13, weight: .bold))
                        .foregroundStyle(title == "Find" ? .white : LabColor.ink)
                        .padding(.horizontal, 16).padding(.vertical, 9)
                        .background(title == "Find" ? LabColor.ink : .clear, in: Capsule())
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Capsule().fill(node.variant == 1 ? LabColor.goldSoft : .white)
                .overlay(Capsule().stroke(LabColor.ink, lineWidth: 2))
                .shadow(color: LabColor.ink.opacity(0.9), radius: 0, x: 4, y: 4))

        case .toolbar:
            HStack(spacing: 10) {
                ForEach(["\u{2190}", "\u{2295}", "\u{2699}", "\u{2691}", "\u{22EF}"], id: \.self) { glyph in
                    Text(glyph).font(.system(size: 17, weight: .bold)).foregroundStyle(LabColor.ink)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .labPanel(.white, radius: 10)
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(LabColor.paper)

        default: // sidebarList
            VStack(alignment: .leading, spacing: 8) {
                Text("TÍMI").font(.system(size: 10, weight: .black)).tracking(2).foregroundStyle(LabColor.coral)
                ForEach(["Find care", "My pets", "Activity", "Paw It Forward", "Settings"], id: \.self) { title in
                    HStack(spacing: 8) {
                        Circle().fill(LabColor.blueSoft).frame(width: 18, height: 18)
                            .overlay(Circle().stroke(LabColor.ink, lineWidth: 1.5))
                        Text(title).font(.system(size: 13, weight: title == "Find care" ? .bold : .regular))
                            .foregroundStyle(LabColor.ink)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 7)
                    .background(title == "Find care" ? LabColor.blueSoft : .clear,
                                in: RoundedRectangle(cornerRadius: 9))
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .labPanel()
        }
    }

    // MARK: Moving between

    @ViewBuilder private var moving: some View {
        switch node.kind {
        case .backButton:
            HStack(spacing: 7) {
                Text("\u{2190}").font(.system(size: 17, weight: .black))
                Text(node.label.isEmpty ? "Back" : node.label).font(.system(size: 14, weight: .bold))
            }
            .foregroundStyle(LabColor.ink)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labPanel(.white, radius: 12)

        case .breadcrumb:
            HStack(spacing: 8) {
                ForEach(Array(["Find care", "Offers", "Bayview"].enumerated()), id: \.offset) { i, part in
                    if i > 0 { Text("/").foregroundStyle(LabColor.muted) }
                    Text(part)
                        .font(.system(size: 13, weight: i == 2 ? .bold : .regular))
                        .foregroundStyle(i == 2 ? LabColor.ink : LabColor.blue)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(LabColor.paper)

        case .navMenu:
            HStack(spacing: 8) {
                VStack(spacing: 3) {
                    ForEach(0..<3, id: \.self) { _ in
                        Rectangle().frame(height: 2).foregroundStyle(LabColor.ink)
                    }
                }.frame(width: 18)
                Text(node.label.isEmpty ? "Menu" : node.label).font(.system(size: 14, weight: .bold))
                    .foregroundStyle(LabColor.ink)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labPanel(.white, radius: 12)

        case .searchField:
            HStack(spacing: 9) {
                Text("\u{2315}").font(.system(size: 16, weight: .bold)).foregroundStyle(LabColor.muted)
                Text(node.label.isEmpty ? "Search clinics" : node.label)
                    .font(.system(size: 14)).foregroundStyle(LabColor.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .labCard(.white, radius: 12, offset: 2)

        case .segmented:
            HStack(spacing: 0) {
                ForEach(Array(["Urgent", "Routine", "Advice"].enumerated()), id: \.offset) { i, title in
                    Text(title).font(.system(size: 13, weight: .bold))
                        .foregroundStyle(i == 0 ? .white : LabColor.ink)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(i == 0 ? LabColor.ink : (node.variant == 2 ? LabColor.goldSoft : .white))
                    if i < 2 { Rectangle().frame(width: 2).foregroundStyle(LabColor.ink) }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: node.variant == 1 ? 999 : 12))
            .overlay(RoundedRectangle(cornerRadius: node.variant == 1 ? 999 : 12)
                .stroke(LabColor.ink, lineWidth: 2))

        default: // chipRow
            HStack(spacing: 8) {
                ForEach(Array(["Open now", "Emergency", "Under 15 min", "Exotics"].enumerated()), id: \.offset) { i, title in
                    Text(title).font(.system(size: 12, weight: .bold))
                        .foregroundStyle(i == 0 ? .white : LabColor.ink)
                        .padding(.horizontal, 13).padding(.vertical, 7)
                        .background(i == 0 ? LabColor.blue : (node.variant == 1 ? LabColor.goldSoft : .white),
                                    in: Capsule())
                        .overlay(Capsule().stroke(LabColor.ink, lineWidth: 1.5))
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }

    // MARK: Where you are

    @ViewBuilder private var position: some View {
        switch node.kind {
        case .progressDots, .pageDots:
            HStack(spacing: 9) {
                ForEach(0..<4, id: \.self) { i in
                    Capsule().fill(i == 1 ? LabColor.coral : LabColor.ink.opacity(0.22))
                        .frame(width: i == 1 ? 26 : 10, height: 10)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .stepBar:
            VStack(alignment: .leading, spacing: 6) {
                Text(node.label.isEmpty ? "Step 2 of 4" : node.label)
                    .font(.system(size: 11, weight: .black)).tracking(1.2)
                    .foregroundStyle(LabColor.muted)
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(LabColor.ink.opacity(0.14))
                        Capsule().fill(node.variant == 1 ? LabColor.blue : LabColor.coral)
                            .frame(width: geo.size.width * 0.5)
                    }
                }
                .frame(height: 8)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        default: // statusStrip
            HStack(spacing: 10) {
                Text("\u{26A0}").font(.system(size: 14, weight: .black)).foregroundStyle(LabColor.ink)
                Text(node.label.isEmpty
                     ? "Tími is not a veterinary practice and does not give medical advice."
                     : node.label)
                    .font(.system(size: 12, weight: .semibold)).foregroundStyle(LabColor.ink)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(LabColor.goldSoft)
            .overlay(Rectangle().frame(height: 2).foregroundStyle(LabColor.ink), alignment: .top)
        }
    }

    // MARK: Thumb-first

    @ViewBuilder private var thumb: some View {
        switch node.kind {
        case .pilot:
            VStack(spacing: 6) {
                let cols = node.variant == 1 ? 2 : 3
                Grid(horizontalSpacing: 4, verticalSpacing: 4) {
                    ForEach(0..<2, id: \.self) { row in
                        GridRow {
                            ForEach(0..<cols, id: \.self) { col in
                                RoundedRectangle(cornerRadius: 5)
                                    .fill(row == 0 && col == 1 ? LabColor.gold : .white)
                                    .overlay(RoundedRectangle(cornerRadius: 5)
                                        .stroke(row == 0 && col == 1 ? LabColor.ink : LabColor.muted, lineWidth: 1.5))
                            }
                        }
                    }
                }
                Text("PILOT").font(.system(size: 8, weight: .black)).tracking(1.4)
                    .foregroundStyle(LabColor.muted)
            }
            .padding(9)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labCard(LabColor.paper, radius: 16)

        case .deck:
            HStack(spacing: 10) {
                ForEach(0..<5, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 13)
                        .fill(i == 3 ? LabColor.blueSoft : .white)
                        .overlay(RoundedRectangle(cornerRadius: 13)
                            .stroke(i == 3 ? LabColor.blue : LabColor.ink, lineWidth: 2))
                        .overlay(Text(["Dog", "Cat", "Rabbit", "Bird", "Other"][i])
                            .font(.system(size: 12, weight: .bold)).foregroundStyle(LabColor.ink))
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .board:
            let cols = node.variant == 1 ? 2 : 3
            Grid(horizontalSpacing: 10, verticalSpacing: 10) {
                ForEach(0..<2, id: \.self) { row in
                    GridRow {
                        ForEach(0..<cols, id: \.self) { col in
                            RoundedRectangle(cornerRadius: 15)
                                .fill(row == 0 && col == 0 ? LabColor.blueSoft : .white)
                                .overlay(RoundedRectangle(cornerRadius: 15)
                                    .stroke(row == 0 && col == 0 ? LabColor.blue : LabColor.ink, lineWidth: 2))
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .radialDial:
            ZStack {
                Circle().stroke(LabColor.ink, style: StrokeStyle(lineWidth: 2, dash: [6, 5]))
                ForEach(0..<6, id: \.self) { i in
                    let angle = Double(i) / 6.0 * 2 * .pi - .pi / 2
                    Circle()
                        .fill(i == 1 ? LabColor.coral : .white)
                        .overlay(Circle().stroke(LabColor.ink, lineWidth: 2))
                        .frame(width: 34, height: 34)
                        .offset(x: cos(angle) * (min(node.width, node.height) / 2 - 22),
                                y: sin(angle) * (min(node.width, node.height) / 2 - 22))
                }
                if node.variant == 1 {
                    Circle().fill(LabColor.ink).frame(width: 18, height: 18)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .thumbArc:
            ZStack {
                Path { p in
                    p.addArc(center: CGPoint(x: node.width, y: node.height),
                             radius: min(node.width, node.height) * 0.86,
                             startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
                }
                .stroke(LabColor.green, style: StrokeStyle(lineWidth: 2, dash: [6, 5]))
                ForEach(0..<3, id: \.self) { i in
                    let angle = Double(180 + 30 + i * 30) * .pi / 180
                    let r = min(node.width, node.height) * 0.86
                    Circle().fill(i == 1 ? LabColor.coral : .white)
                        .overlay(Circle().stroke(LabColor.ink, lineWidth: 2))
                        .frame(width: 38, height: 38)
                        .position(x: node.width + cos(angle) * r, y: node.height + sin(angle) * r)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .actionRail:
            VStack(spacing: 8) {
                Spacer(minLength: 0)
                if node.variant != 2 { LabQuietButton(title: "Call") }
                if node.variant == 1 { LabQuietButton(title: "Navigate") }
                LabPrimaryButton(title: node.label.isEmpty ? "Continue" : node.label)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)

        case .fab:
            Circle().fill(LabColor.coral)
                .overlay(Circle().stroke(LabColor.ink, lineWidth: 2))
                .overlay(Text("\u{2192}").font(.system(size: 24, weight: .black)).foregroundStyle(.white))
                .shadow(color: LabColor.ink.opacity(0.9), radius: 0, x: 4, y: 4)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        default: // speedDial
            VStack(spacing: 10) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle().fill(.white).overlay(Circle().stroke(LabColor.ink, lineWidth: 2))
                        .frame(width: 44, height: 44)
                }
                Circle().fill(LabColor.coral).overlay(Circle().stroke(LabColor.ink, lineWidth: 2))
                    .overlay(Text("\u{00D7}").font(.system(size: 22, weight: .black)).foregroundStyle(.white))
                    .frame(width: 60, height: 60)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
    }

    // MARK: Surfaces

    @ViewBuilder private var surfaces: some View {
        switch node.kind {
        case .bottomSheet:
            VStack(spacing: 12) {
                Capsule().fill(LabColor.ink.opacity(0.3)).frame(width: 52, height: 6).padding(.top, 10)
                Text(node.label.isEmpty ? "Bayview Animal Hospital" : node.label)
                    .font(.system(size: 18, weight: .black)).foregroundStyle(LabColor.ink)
                Text("12 minutes away \u{00B7} capacity reported 40 seconds ago")
                    .font(.system(size: 12)).foregroundStyle(LabColor.muted)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22)
                    .fill(LabColor.paper)
                    .overlay(UnevenRoundedRectangle(topLeadingRadius: 22, topTrailingRadius: 22)
                        .stroke(LabColor.ink, lineWidth: 2))
            )

        case .modalCard:
            VStack(spacing: 10) {
                Text(node.label.isEmpty ? "Leave this search?" : node.label)
                    .font(.system(size: 17, weight: .black)).foregroundStyle(LabColor.ink)
                Text("Clinics are still answering. Leaving cancels it.")
                    .font(.system(size: 12)).foregroundStyle(LabColor.muted)
                    .multilineTextAlignment(.center)
                Spacer(minLength: 0)
                LabPrimaryButton(title: "Stay")
                LabQuietButton(title: "Leave")
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labCard(.white, radius: 20, offset: 6)

        case .sheetGrabber, .drawerHandle:
            Capsule().fill(LabColor.ink.opacity(0.35))
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .splitDivider:
            ZStack {
                Rectangle().fill(LabColor.ink.opacity(0.12))
                Capsule().fill(LabColor.ink.opacity(0.4)).frame(width: 5, height: 44)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        default: // toast
            HStack(spacing: 10) {
                Circle().fill(LabColor.green).frame(width: 9, height: 9)
                Text(node.label.isEmpty ? "Bayview is expecting you." : node.label)
                    .font(.system(size: 13, weight: .bold)).foregroundStyle(LabColor.ink)
                Spacer(minLength: 0)
                Text("\u{00D7}").font(.system(size: 15, weight: .black)).foregroundStyle(LabColor.muted)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labCard(.white, radius: 14, offset: 3)
        }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        switch node.kind {
        case .wordmark:
            LabWordmark().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        case .headline:
            Text(node.label.isEmpty ? "Tell us about Humphrey." : node.label)
                .font(.system(size: max(18, min(44, node.height * 0.42)), weight: .black, design: .serif))
                .foregroundStyle(LabColor.ink)
                .minimumScaleFactor(0.5)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

        case .bodyText:
            Text(node.label.isEmpty
                 ? "A little context helps clinics answer faster. Only the species is required \u{2014} everything else can wait."
                 : node.label)
                .font(.system(size: 14)).foregroundStyle(LabColor.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

        case .textField:
            HStack {
                Text(node.label.isEmpty ? "Pet\u{2019}s name" : node.label)
                    .font(.system(size: 15)).foregroundStyle(LabColor.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labCard(.white, radius: 14, offset: 3)

        case .primaryButton:
            LabPrimaryButton(title: node.label.isEmpty ? "Continue" : node.label)

        case .quietButton:
            LabQuietButton(title: node.label.isEmpty ? "Not now" : node.label)

        case .speciesChips:
            HStack(spacing: 8) {
                ForEach(Array(["Dog", "Cat", "Rabbit", "Bird", "Reptile", "Other"].enumerated()), id: \.offset) { i, title in
                    VStack(spacing: 5) {
                        Circle().fill(i == 0 ? LabColor.blue : LabColor.ink.opacity(0.14))
                            .frame(width: 20, height: 20)
                        Text(title).font(.system(size: 11, weight: .bold)).foregroundStyle(LabColor.ink)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(i == 0 ? LabColor.blueSoft : .white, in: RoundedRectangle(cornerRadius: 13))
                    .overlay(RoundedRectangle(cornerRadius: 13)
                        .stroke(i == 0 ? LabColor.blue : LabColor.ink, lineWidth: 2))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .offerCard:
            VStack(alignment: .leading, spacing: 6) {
                Text("12 min away").font(.system(size: 11, weight: .black)).tracking(1)
                    .foregroundStyle(LabColor.coral)
                Text(node.label.isEmpty ? "Bayview Animal Hospital" : node.label)
                    .font(.system(size: 16, weight: .black)).foregroundStyle(LabColor.ink)
                Text("Reported capacity 40 seconds ago")
                    .font(.system(size: 11)).foregroundStyle(LabColor.muted)
                Spacer(minLength: 0)
                LabPrimaryButton(title: "Choose")
            }
            .padding(14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .labCard(.white, radius: 18)

        case .clinicRow:
            HStack(spacing: 12) {
                Text("1").font(.system(size: 14, weight: .black)).foregroundStyle(.white)
                    .frame(width: 28, height: 28).background(LabColor.blue, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(node.label.isEmpty ? "Bayview Animal Hospital" : node.label)
                        .font(.system(size: 14, weight: .bold)).foregroundStyle(LabColor.ink)
                    Text("Address shown on confirmation")
                        .font(.system(size: 11)).foregroundStyle(LabColor.muted)
                }
                Spacer(minLength: 0)
                Text("12\u{2032}").font(.system(size: 14, weight: .black)).foregroundStyle(LabColor.ink)
            }
            .padding(12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labCard(.white, radius: 16, offset: 3)

        case .mapPlaceholder:
            ZStack {
                LabColor.greenSoft
                Path { p in
                    p.move(to: CGPoint(x: 0, y: node.height * 0.7))
                    p.addQuadCurve(to: CGPoint(x: node.width, y: node.height * 0.3),
                                   control: CGPoint(x: node.width * 0.5, y: node.height * 0.85))
                }
                .stroke(LabColor.blue, lineWidth: 5)
                Circle().fill(LabColor.coral).overlay(Circle().stroke(LabColor.ink, lineWidth: 2))
                    .frame(width: 22, height: 22)
                    .position(x: node.width * 0.78, y: node.height * 0.42)
                Text("MAP").font(.system(size: 11, weight: .black)).tracking(2)
                    .foregroundStyle(LabColor.green)
                    .position(x: 44, y: 20)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(LabColor.ink, lineWidth: 2))
            .clipShape(RoundedRectangle(cornerRadius: 16))

        case .countdown:
            VStack(spacing: 2) {
                Text(node.label.isEmpty ? "0:47" : node.label)
                    .font(.system(size: max(18, node.height * 0.46), weight: .black, design: .rounded))
                    .foregroundStyle(LabColor.ink)
                    .monospacedDigit()
                Text("LEFT TO ANSWER").font(.system(size: 8, weight: .black)).tracking(1.4)
                    .foregroundStyle(LabColor.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .labCard(LabColor.goldSoft, radius: 14, offset: 3)

        case .priceRow:
            HStack {
                Text(node.label.isEmpty ? "Tími access fee" : node.label)
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(LabColor.ink)
                Spacer(minLength: 0)
                Text("$15.00").font(.system(size: 13, weight: .black)).foregroundStyle(LabColor.ink)
                    .monospacedDigit()
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(Rectangle().frame(height: 1).foregroundStyle(LabColor.ink.opacity(0.2)), alignment: .bottom)

        case .legalNotice:
            Text(node.label.isEmpty
                 ? "An availability report is not an appointment and reserves no place in a clinic\u{2019}s triage order."
                 : node.label)
                .font(.system(size: 11)).foregroundStyle(LabColor.muted)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

        default: // petAvatar
            Circle().fill(LabColor.goldSoft)
                .overlay(Circle().stroke(LabColor.ink, lineWidth: 2))
                .overlay(Text("H").font(.system(size: max(16, node.height * 0.4), weight: .black))
                    .foregroundStyle(LabColor.ink))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

// MARK: - Shared pieces

struct LabWordmark: View {
    var body: some View {
        HStack(alignment: .top, spacing: 1) {
            Text("Tími").font(.system(size: 19, weight: .black, design: .serif))
                .foregroundStyle(LabColor.blue)
            Text("NOW").font(.system(size: 9, weight: .black)).foregroundStyle(LabColor.coral)
                .padding(.top, 2)
        }
        .fixedSize()
    }
}

struct LabPill: View {
    var text: String
    var body: some View {
        Text(text).font(.system(size: 12, weight: .bold)).foregroundStyle(LabColor.blue)
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(Capsule().fill(.white).overlay(Capsule().stroke(LabColor.ink, lineWidth: 1.5)))
    }
}

struct LabTabItem: View {
    var title: String
    var on: Bool
    var style: Int
    var body: some View {
        VStack(spacing: 4) {
            if style == 1 {
                Capsule().fill(on ? LabColor.coral : .clear).frame(width: 22, height: 4)
            }
            Circle().fill(on ? LabColor.blue : LabColor.ink.opacity(0.18))
                .frame(width: 20, height: 20)
            Text(title).font(.system(size: 10, weight: on ? .black : .semibold))
                .foregroundStyle(on ? LabColor.ink : LabColor.muted)
        }
    }
}

struct LabPrimaryButton: View {
    var title: String
    var body: some View {
        Text(title)
            .font(.system(size: 14, weight: .black)).foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 40)
            .background(
                RoundedRectangle(cornerRadius: 14).fill(LabColor.coral)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(LabColor.ink, lineWidth: 2))
                    .shadow(color: LabColor.ink.opacity(0.9), radius: 0, x: 3, y: 4)
            )
    }
}

struct LabQuietButton: View {
    var title: String
    var body: some View {
        Text(title)
            .font(.system(size: 13, weight: .bold)).foregroundStyle(LabColor.ink)
            .frame(maxWidth: .infinity, minHeight: 36)
            .background(
                RoundedRectangle(cornerRadius: 13).fill(.white)
                    .overlay(RoundedRectangle(cornerRadius: 13).stroke(LabColor.ink.opacity(0.3), lineWidth: 1.5))
            )
    }
}
