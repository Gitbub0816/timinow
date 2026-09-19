import SwiftUI

/// The whole app: palette, canvas, inspector, and the bar across the top.
///
/// Three fixed panes rather than a `NavigationSplitView`, because the two
/// side panes are tools that must both stay visible while dragging between
/// them — a split view that collapses one of them on rotation would break the
/// only interaction this app has.
public struct LabRootView: View {
    @StateObject private var store = LabStore()
    @State private var showExport = false
    @State private var renaming = false
    @State private var screenName = ""

    public init() {}

    public var body: some View {
        ZStack {
            VStack(spacing: 0) {
                toolbar
                Divider()
                HStack(spacing: 0) {
                    LabLibraryView().frame(width: 268)
                    Divider()
                    VStack(spacing: 0) {
                        screenTabs
                        Divider()
                        LabCanvasView()
                            .padding(18)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(LabColor.canvas)
                    }
                    Divider()
                    LabInspectorView().frame(width: 286)
                }
            }

            // The dragged ghost rides above everything, following the finger.
            if let ghost = store.ghost {
                LabComponentView(node: LabNode(kind: ghost.kind, x: 0, y: 0))
                    .scaleEffect(store.canvasFrame.scale > 0 ? store.canvasFrame.scale : 0.6)
                    .opacity(0.85)
                    .allowsHitTesting(false)
                    .position(ghost.point)
            }
        }
        .coordinateSpace(name: "labRoot")
        .onPreferenceChange(LabCanvasFrameKey.self) { store.canvasFrame = $0 }
        .environmentObject(store)
        .sheet(isPresented: $showExport) { LabExportView().environmentObject(store) }
        .alert("Rename screen", isPresented: $renaming) {
            TextField("Name", text: $screenName)
            Button("Rename") { store.renameScreen(screenName) }
            Button("Cancel", role: .cancel) {}
        }
    }

    // MARK: Top bar

    private var toolbar: some View {
        HStack(spacing: 14) {
            HStack(alignment: .top, spacing: 2) {
                Text("Layout").font(.system(size: 17, weight: .black, design: .serif))
                    .foregroundStyle(LabColor.ink)
                Text("LAB").font(.system(size: 9, weight: .black)).foregroundStyle(LabColor.coral)
                    .padding(.top, 2)
            }

            Divider().frame(height: 26)

            Picker("Canvas", selection: Binding(
                get: { store.document.device.name },
                set: { name in
                    if let preset = LabDevice.presets.first(where: { $0.name == name }) {
                        store.setDevice(preset)
                    }
                }
            )) {
                ForEach(LabDevice.presets, id: \.name) { Text($0.name).tag($0.name) }
            }
            .pickerStyle(.menu)

            HStack(spacing: 6) {
                LabNumberField(title: "W", value: store.document.device.width) { w in
                    store.setDevice(LabDevice(name: "Custom", width: max(320, w),
                                              height: store.document.device.height))
                }
                .frame(width: 74)
                LabNumberField(title: "H", value: store.document.device.height) { h in
                    store.setDevice(LabDevice(name: "Custom", width: store.document.device.width,
                                              height: max(320, h)))
                }
                .frame(width: 74)
            }

            Divider().frame(height: 26)

            Toggle("Grid", isOn: $store.showGrid).toggleStyle(.button)
            Toggle("Snap", isOn: $store.snapToGrid).toggleStyle(.button)
            Toggle("Reach", isOn: $store.showReach).toggleStyle(.button)

            Picker("Hand", selection: Binding(
                get: { store.document.handedness },
                set: { store.document.handedness = $0; store.save() }
            )) {
                Text("Right").tag("right")
                Text("Left").tag("left")
                Text("Centred").tag("centre")
            }
            .pickerStyle(.segmented)
            .frame(width: 230)

            Spacer()

            Button(role: .destructive) { store.resetToSeed() } label: {
                Label("Reset", systemImage: "arrow.counterclockwise")
            }
            Button { showExport = true } label: {
                Label("Export", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.borderedProminent)
        }
        .font(.system(size: 13, weight: .semibold))
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(LabColor.paper)
    }

    // MARK: Screen tabs

    private var screenTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(store.document.screens.enumerated()), id: \.element.id) { index, screen in
                    Button {
                        if store.screenIndex == index {
                            screenName = screen.name
                            renaming = true
                        } else {
                            store.screenIndex = index
                            store.selection = nil
                        }
                    } label: {
                        HStack(spacing: 7) {
                            Text(screen.name).font(.system(size: 13, weight: .bold))
                            Text("\(screen.nodes.count)")
                                .font(.system(size: 10, weight: .black)).monospacedDigit()
                                .foregroundStyle(store.screenIndex == index ? .white.opacity(0.75) : LabColor.muted)
                        }
                        .foregroundStyle(store.screenIndex == index ? .white : LabColor.ink)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(store.screenIndex == index ? LabColor.ink : .white, in: Capsule())
                        .overlay(Capsule().stroke(LabColor.ink, lineWidth: 1.5))
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button("Rename") { screenName = screen.name; renaming = true }
                        Button("Delete", role: .destructive) { store.removeScreen(at: index) }
                    }
                }
                Button { store.addScreen() } label: {
                    Image(systemName: "plus").font(.system(size: 13, weight: .black))
                        .foregroundStyle(LabColor.ink)
                        .padding(9)
                        .background(Circle().fill(.white).overlay(Circle().stroke(LabColor.ink, lineWidth: 1.5)))
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
                Text("Tap the open tab to rename it. Long-press for delete.")
                    .font(.system(size: 10)).foregroundStyle(LabColor.muted)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
        }
        .background(LabColor.paper)
    }
}
