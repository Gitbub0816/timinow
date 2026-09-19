import SwiftUI

/// The drawing surface.
///
/// The canvas is always laid out at the device's true point size and then
/// scaled to fit, so every number in the document is a real point value you
/// could paste into a SwiftUI `.frame` — no "canvas units" to convert.
///
/// Drags resolve `value.location` inside a named coordinate space attached to
/// the unscaled node layer, rather than accumulating `translation`. That makes
/// them correct at any zoom without the code needing to know the scale, and it
/// means a drag cannot drift away from the finger over a long gesture.
public struct LabCanvasView: View {
    @EnvironmentObject var store: LabStore

    private let space = "labCanvas"

    public init() {}

    public var body: some View {
        GeometryReader { geo in
            let device = store.document.device
            let scale = min(geo.size.width / device.width,
                            geo.size.height / device.height)
            let shown = CGSize(width: device.width * scale, height: device.height * scale)

            ZStack {
                canvas(device: device)
                    .frame(width: device.width, height: device.height)
                    .scaleEffect(scale, anchor: .topLeading)
                    .frame(width: shown.width, height: shown.height, alignment: .topLeading)
                    .background(
                        GeometryReader { inner in
                            Color.clear.preference(key: LabCanvasFrameKey.self,
                                                   value: LabCanvasFrame(
                                                       origin: inner.frame(in: .named("labRoot")).origin,
                                                       scale: scale))
                        }
                    )
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    @ViewBuilder
    private func canvas(device: LabDevice) -> some View {
        ZStack(alignment: .topLeading) {
            Rectangle().fill(LabColor.paper)

            if store.showGrid {
                LabGrid(step: store.document.gridStep, size: CGSize(width: device.width, height: device.height))
            }

            ForEach(store.screen.nodes) { node in
                LabNodeView(node: node, space: space)
            }

            // The thumb-reach guide. Drawn over everything, hit-testing off —
            // it is a reminder, not a component, and it is the reason this
            // whole app exists.
            if store.showReach {
                LabReachOverlay(size: CGSize(width: device.width, height: device.height),
                                hand: store.document.handedness)
                    .allowsHitTesting(false)
            }
        }
        .coordinateSpace(name: space)
        .contentShape(Rectangle())
        .onTapGesture { store.selection = nil }
        .overlay(Rectangle().stroke(LabColor.ink, lineWidth: 2))
    }
}

/// Where the canvas sits in the window, and how much it is scaled — published
/// upward so a drag from the library can be converted into canvas points.
public struct LabCanvasFrame: Equatable {
    public var origin: CGPoint
    public var scale: CGFloat
    public init(origin: CGPoint = .zero, scale: CGFloat = 1) {
        self.origin = origin; self.scale = scale
    }
}

public struct LabCanvasFrameKey: PreferenceKey {
    public static let defaultValue = LabCanvasFrame()
    public static func reduce(value: inout LabCanvasFrame, nextValue: () -> LabCanvasFrame) {
        value = nextValue()
    }
}

// MARK: - One placed component

struct LabNodeView: View {
    @EnvironmentObject var store: LabStore
    var node: LabNode
    var space: String

    @State private var grabOffset: CGSize?
    @State private var resizeStart: CGSize?

    private var selected: Bool { store.selection == node.id }

    var body: some View {
        LabComponentView(node: node)
            .frame(width: node.width, height: node.height)
            .contentShape(Rectangle())
            .overlay(selectionChrome)
            .position(x: node.x + node.width / 2, y: node.y + node.height / 2)
            .gesture(moveGesture)
            .onTapGesture { store.selection = node.id }
            .accessibilityLabel("\(node.kind.title), at \(Int(node.x)), \(Int(node.y)), \(Int(node.width)) by \(Int(node.height))")
    }

    @ViewBuilder private var selectionChrome: some View {
        if selected {
            ZStack {
                Rectangle()
                    .stroke(LabColor.blue, style: StrokeStyle(lineWidth: 2, dash: [5, 4]))
                if !node.locked {
                    // One handle, bottom-trailing. Two axes from one grip is
                    // enough at this scale, and eight handles on a component
                    // 40pt tall is a target soup.
                    Rectangle()
                        .fill(LabColor.blue)
                        .overlay(Rectangle().stroke(.white, lineWidth: 2))
                        .frame(width: 22, height: 22)
                        .position(x: node.width, y: node.height)
                        .gesture(resizeGesture)
                }
                if node.locked {
                    Text("LOCKED").font(.system(size: 9, weight: .black)).tracking(1)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(LabColor.ink, in: Capsule())
                        .position(x: node.width - 34, y: -10)
                }
            }
        }
    }

    private var moveGesture: some Gesture {
        DragGesture(minimumDistance: 2, coordinateSpace: .named(space))
            .onChanged { value in
                guard !node.locked else { return }
                if store.selection != node.id { store.selection = node.id }
                let offset = grabOffset ?? CGSize(width: value.startLocation.x - node.x,
                                                  height: value.startLocation.y - node.y)
                if grabOffset == nil { grabOffset = offset }
                var moved = node
                moved.x = store.snap(value.location.x - offset.width)
                moved.y = store.snap(value.location.y - offset.height)
                store.update(moved)
            }
            .onEnded { _ in grabOffset = nil }
    }

    private var resizeGesture: some Gesture {
        DragGesture(minimumDistance: 1, coordinateSpace: .named(space))
            .onChanged { value in
                guard !node.locked else { return }
                let start = resizeStart ?? CGSize(width: node.width, height: node.height)
                if resizeStart == nil { resizeStart = start }
                var sized = node
                sized.width = max(24, store.snap(value.location.x - node.x))
                sized.height = max(18, store.snap(value.location.y - node.y))
                store.update(sized)
            }
            .onEnded { _ in resizeStart = nil }
    }
}

// MARK: - Backdrops

struct LabGrid: View {
    var step: Double
    var size: CGSize

    var body: some View {
        Canvas { context, _ in
            guard step >= 4 else { return }
            var path = Path()
            var x = step
            while x < size.width { path.move(to: CGPoint(x: x, y: 0)); path.addLine(to: CGPoint(x: x, y: size.height)); x += step }
            var y = step
            while y < size.height { path.move(to: CGPoint(x: 0, y: y)); path.addLine(to: CGPoint(x: size.width, y: y)); y += step }
            context.stroke(path, with: .color(LabColor.ink.opacity(0.06)), lineWidth: 1)
        }
        .frame(width: size.width, height: size.height)
        .allowsHitTesting(false)
    }
}

/// The comfortable thumb sweep, drawn where the hand actually is.
struct LabReachOverlay: View {
    var size: CGSize
    var hand: String

    var body: some View {
        Canvas { context, _ in
            let pivotX: CGFloat = hand == "left" ? size.width * 0.12
                                 : hand == "centre" ? size.width * 0.5
                                 : size.width * 0.88
            let pivotY = size.height * 0.97
            let radius = min(size.width, size.height) * 0.92
            let circle = Path(ellipseIn: CGRect(x: pivotX - radius, y: pivotY - radius,
                                                width: radius * 2, height: radius * 2))
            context.fill(circle, with: .color(LabColor.green.opacity(0.08)))
            context.stroke(circle, with: .color(LabColor.green.opacity(0.55)),
                           style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
        }
        .frame(width: size.width, height: size.height)
    }
}
