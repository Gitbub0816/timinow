import Foundation
import SwiftUI

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

public struct LabCanvasView: View {
    @EnvironmentObject var store: LabStore
    private let space = "labCanvas"

    public init() {}

    public var body: some View {
        GeometryReader { geo in
            let device = store.document.device
            let scale = min(geo.size.width / device.pointWidth,
                            geo.size.height / device.pointHeight)
            let shown = CGSize(width: device.pointWidth * scale,
                               height: device.pointHeight * scale)
            canvas(device: device)
                .frame(width: device.pointWidth, height: device.pointHeight)
                .scaleEffect(scale, anchor: .topLeading)
                .frame(width: shown.width, height: shown.height, alignment: .topLeading)
                .background(
                    GeometryReader { inner in
                        Color.clear.preference(
                            key: LabCanvasFrameKey.self,
                            value: LabCanvasFrame(origin: inner.frame(in: .named("labRoot")).origin,
                                                  scale: scale))
                    }
                )
                .frame(width: geo.size.width, height: geo.size.height, alignment: .center)
        }
    }

    @ViewBuilder
    private func canvas(device: LabDevice) -> some View {
        let size = CGSize(width: device.pointWidth, height: device.pointHeight)
        ZStack(alignment: .topLeading) {
            Rectangle().fill(LabColor.paper)

            if store.showGrid {
                LabGrid(step: store.document.gridStep, size: size)
            }

            ForEach(store.screen.instances) { instance in
                if let component = store.component(instance.componentID) {
                    LabPlacedView(instance: instance, component: component, space: space)
                }
            }

            if store.document.reach.show {
                LabReachOverlay(device: device, reach: store.document.reach)
                    .allowsHitTesting(false)
            }

            LabGuides(x: store.guidesX, y: store.guidesY, size: size)
                .allowsHitTesting(false)

            if store.showRuler {
                LabRuler(device: device).allowsHitTesting(false)
            }
        }
        .coordinateSpace(name: space)
        .contentShape(Rectangle())
        .onTapGesture { store.selection = [] }
        .overlay(Rectangle().stroke(LabColor.ink, lineWidth: 2))
    }
}

// MARK: - One placed instance

struct LabPlacedView: View {
    @EnvironmentObject var store: LabStore
    var instance: LabInstance
    var component: LabComponent
    var space: String

    @State private var grab: CGSize?

    private var selected: Bool { store.selection.contains(instance.id) }

    var body: some View {
        LabInstanceView(component: component, instance: instance)
            .frame(width: instance.width, height: instance.height)
            .contentShape(Rectangle())
            .overlay(chrome)
            .position(x: instance.x + instance.width / 2, y: instance.y + instance.height / 2)
            .gesture(moveGesture)
            .onTapGesture { toggleSelection() }
            .accessibilityLabel("\(component.name) at \(Int(instance.x)), \(Int(instance.y))")
    }

    private func toggleSelection() {
        // Plain tap replaces the selection; tapping something already in a
        // multi-selection removes it, which is how you back out of a bad pick
        // without starting over.
        if store.selection.contains(instance.id), store.selection.count > 1 {
            store.selection.remove(instance.id)
        } else {
            store.selection = [instance.id]
        }
    }

    @ViewBuilder private var chrome: some View {
        if selected {
            ZStack {
                Rectangle().stroke(LabColor.blue, style: StrokeStyle(lineWidth: 2, dash: [5, 4]))
                if !instance.locked {
                    handle.position(x: instance.width, y: instance.height)
                        .gesture(resizeGesture)
                    rotator.position(x: instance.width / 2, y: -18)
                        .gesture(rotateGesture)
                }
            }
        }
    }

    private var handle: some View {
        Rectangle().fill(LabColor.blue)
            .overlay(Rectangle().stroke(.white, lineWidth: 2))
            .frame(width: 22, height: 22)
    }

    private var rotator: some View {
        Circle().fill(LabColor.gold)
            .overlay(Circle().stroke(LabColor.ink, lineWidth: 2))
            .overlay(Image(systemName: "arrow.clockwise")
                .font(.system(size: 10, weight: .black)).foregroundStyle(LabColor.ink))
            .frame(width: 24, height: 24)
    }

    // MARK: Gestures

    private var moveGesture: some Gesture {
        DragGesture(minimumDistance: 2, coordinateSpace: .named(space))
            .onChanged { value in
                guard !instance.locked else { return }
                if !store.selection.contains(instance.id) { store.selection = [instance.id] }
                let offset = grab ?? CGSize(width: value.startLocation.x - instance.x,
                                            height: value.startLocation.y - instance.y)
                if grab == nil { grab = offset }

                var moved = instance
                var x = store.snap(value.location.x - offset.width)
                var y = store.snap(value.location.y - offset.height)

                // Magnet to neighbours. Tested on all three of each edge so a
                // component can line up left-to-left, centre-to-centre, or
                // left-to-right against whatever is already placed.
                let candidates = store.snapCandidates(excluding: store.selection)
                var gx: [Double] = []
                var gy: [Double] = []
                for (probe, delta) in [(x, 0.0), (x + moved.width / 2, moved.width / 2),
                                       (x + moved.width, moved.width)] {
                    let hit = store.magnet(probe, candidates.x)
                    if let guide = hit.guide { x = hit.value - delta; gx = [guide]; break }
                }
                for (probe, delta) in [(y, 0.0), (y + moved.height / 2, moved.height / 2),
                                       (y + moved.height, moved.height)] {
                    let hit = store.magnet(probe, candidates.y)
                    if let guide = hit.guide { y = hit.value - delta; gy = [guide]; break }
                }
                store.guidesX = gx
                store.guidesY = gy

                let dx = x - instance.x
                let dy = y - instance.y
                moved.x = x
                moved.y = y
                store.update(moved)

                // Everything else selected moves with it.
                for other in store.selectedInstances where other.id != instance.id && !other.locked {
                    var shifted = other
                    shifted.x += dx
                    shifted.y += dy
                    store.update(shifted)
                }
            }
            .onEnded { _ in
                grab = nil
                store.guidesX = []
                store.guidesY = []
            }
    }

    private var resizeGesture: some Gesture {
        DragGesture(minimumDistance: 1, coordinateSpace: .named(space))
            .onChanged { value in
                guard !instance.locked else { return }
                var sized = instance
                sized.width = max(16, store.snap(value.location.x - instance.x))
                sized.height = max(12, store.snap(value.location.y - instance.y))
                store.update(sized)
            }
    }

    private var rotateGesture: some Gesture {
        DragGesture(minimumDistance: 1, coordinateSpace: .named(space))
            .onChanged { value in
                guard !instance.locked else { return }
                let cx = instance.x + instance.width / 2
                let cy = instance.y + instance.height / 2
                let angle = atan2(value.location.y - cy, value.location.x - cx) * 180 / .pi + 90
                var turned = instance
                // Free rotation, but every 15° sticks, so upright and the four
                // quarter turns are easy to land on without a modifier key.
                let stepped = (angle / 15).rounded() * 15
                turned.rotation = abs(angle - stepped) < 4 ? stepped : angle
                store.update(turned)
            }
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
    }
}

struct LabGuides: View {
    var x: [Double]
    var y: [Double]
    var size: CGSize
    var body: some View {
        Canvas { context, _ in
            var path = Path()
            for value in x { path.move(to: CGPoint(x: value, y: 0)); path.addLine(to: CGPoint(x: value, y: size.height)) }
            for value in y { path.move(to: CGPoint(x: 0, y: value)); path.addLine(to: CGPoint(x: size.width, y: value)) }
            context.stroke(path, with: .color(LabColor.coral), lineWidth: 1.5)
        }
        .frame(width: size.width, height: size.height)
    }
}

/// The thumb sweep, in millimetres.
///
/// The previous version took the radius as a fraction of the screen, which
/// makes every device equally reachable and is simply wrong: a thumb is the
/// same length whatever it is holding. This one converts real millimetres
/// into points using the device's measured width, and draws nothing at all
/// when that measurement is missing — an arc with no basis is worse than no
/// arc, because it gets believed.
struct LabReachOverlay: View {
    var device: LabDevice
    var reach: LabReach

    var body: some View {
        Canvas { context, _ in
            let ppmm = device.pointsPerMM
            let w = device.pointWidth, h = device.pointHeight

            guard ppmm > 0 else {
                let text = Text("Measure the screen to see the thumb arc \u{2014} toggle the ruler")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(LabColor.coral)
                context.draw(text, at: CGPoint(x: w / 2, y: h - 26))
                return
            }

            let inset = reach.pivotInsetMM * ppmm
            let pivotX: CGFloat = reach.hand == "left" ? inset
                                 : reach.hand == "centre" ? w / 2
                                 : w - inset
            let pivotY = h - reach.pivotBottomMM * ppmm

            let stretch = reach.stretchMM * ppmm
            let comfortable = reach.comfortableMM * ppmm

            let stretchPath = Path(ellipseIn: CGRect(x: pivotX - stretch, y: pivotY - stretch,
                                                     width: stretch * 2, height: stretch * 2))
            context.stroke(stretchPath, with: .color(LabColor.gold),
                           style: StrokeStyle(lineWidth: 2, dash: [10, 7]))

            let comfortPath = Path(ellipseIn: CGRect(x: pivotX - comfortable, y: pivotY - comfortable,
                                                     width: comfortable * 2, height: comfortable * 2))
            context.fill(comfortPath, with: .color(LabColor.green.opacity(0.10)))
            context.stroke(comfortPath, with: .color(LabColor.green),
                           style: StrokeStyle(lineWidth: 2, dash: [8, 6]))

            let caption = Text("\(Int(reach.comfortableMM))mm comfortable \u{00B7} \(Int(reach.stretchMM))mm stretch")
                .font(.system(size: 12, weight: .heavy))
                .foregroundStyle(LabColor.green)
            context.draw(caption, at: CGPoint(x: pivotX, y: pivotY - 12))
        }
        .frame(width: device.pointWidth, height: device.pointHeight)
    }
}

/// A 50mm scale bar, for calibrating the device against a physical ruler.
///
/// This is how the millimetre figures get filled in without anybody having to
/// find a spec sheet: hold a ruler against the iPad, adjust the physical width
/// in the toolbar until this bar measures 50mm, and every reach figure on the
/// canvas becomes true at once.
struct LabRuler: View {
    var device: LabDevice

    var body: some View {
        Canvas { context, _ in
            let ppmm = device.pointsPerMM
            guard ppmm > 0 else { return }
            let y = device.pointHeight - 40.0
            let x0 = 40.0
            let length = 50 * ppmm

            var path = Path()
            path.move(to: CGPoint(x: x0, y: y))
            path.addLine(to: CGPoint(x: x0 + length, y: y))
            for mm in 0...50 {
                let tick: Double = mm % 10 == 0 ? 12 : (mm % 5 == 0 ? 8 : 4)
                let x = x0 + Double(mm) * ppmm
                path.move(to: CGPoint(x: x, y: y))
                path.addLine(to: CGPoint(x: x, y: y - tick))
            }
            context.stroke(path, with: .color(LabColor.ink), lineWidth: 2)
            context.draw(Text("50 mm \u{2014} check against a real ruler")
                .font(.system(size: 11, weight: .heavy))
                .foregroundStyle(LabColor.ink),
                at: CGPoint(x: x0 + length / 2, y: y + 14))
        }
        .frame(width: device.pointWidth, height: device.pointHeight)
    }
}
