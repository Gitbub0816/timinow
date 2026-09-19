import Foundation
import SwiftUI

public struct LabRootView: View {
    @StateObject private var store = LabStore()
    @State private var mode = "screens"
    @State private var showExport = false
    @State private var renaming = false
    @State private var screenName = ""

    public init() {}

    public var body: some View {
        ZStack {
            VStack(spacing: 0) {
                toolbar
                Divider()
                if mode == "components" {
                    HStack(spacing: 0) {
                        LabLibraryView().frame(width: 268)
                        Divider()
                        LabComponentEditor()
                    }
                } else {
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
                        LabInspectorView().frame(width: 300)
                    }
                }
            }

            if let ghost = store.ghost, let component = store.component(ghost.componentID) {
                LabElementView(element: component.root)
                    .frame(width: component.defaultWidth, height: component.defaultHeight)
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

    // MARK: Toolbar

    private var toolbar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                HStack(alignment: .top, spacing: 2) {
                    Text("Layout").font(.system(size: 17, weight: .black, design: .serif))
                    Text("LAB").font(.system(size: 9, weight: .black)).foregroundStyle(LabColor.coral)
                        .padding(.top, 2)
                }

                Picker("Mode", selection: $mode) {
                    Text("Screens").tag("screens")
                    Text("Components").tag("components")
                }
                .pickerStyle(.segmented)
                .frame(width: 200)

                if mode == "screens" { screenTools }

                Spacer(minLength: 20)

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
        }
        .background(LabColor.paper)
    }

    @ViewBuilder private var screenTools: some View {
        Divider().frame(height: 26)

        Picker("Canvas", selection: Binding(
            get: { store.document.device.name },
            set: { name in
                if var preset = LabDevice.presets.first(where: { $0.name == name }) {
                    // Keep a measurement already made for a canvas of the same
                    // point size, so switching presets does not silently throw
                    // away a calibration.
                    if preset.physicalWidthMM == 0,
                       store.document.device.pointWidth == preset.pointWidth {
                        preset.physicalWidthMM = store.document.device.physicalWidthMM
                        preset.physicalHeightMM = store.document.device.physicalHeightMM
                    }
                    store.setDevice(preset)
                }
            }
        )) {
            ForEach(LabDevice.presets, id: \.name) { Text($0.name).tag($0.name) }
        }
        .pickerStyle(.menu)

        HStack(spacing: 6) {
            LabNumberField(title: "PT W", value: store.document.device.pointWidth) { v in
                var d = store.document.device; d.pointWidth = max(200, v); d.name = "Custom"
                store.setDevice(d)
            }.frame(width: 70)
            LabNumberField(title: "PT H", value: store.document.device.pointHeight) { v in
                var d = store.document.device; d.pointHeight = max(200, v); d.name = "Custom"
                store.setDevice(d)
            }.frame(width: 70)
        }

        Divider().frame(height: 26)

        // The millimetre pair. This is what makes the reach arc mean anything:
        // without it the canvas has no idea how big it physically is, and the
        // arc is drawn from a guess.
        HStack(spacing: 6) {
            LabNumberField(title: "MM W", value: store.document.device.physicalWidthMM) { v in
                var d = store.document.device; d.physicalWidthMM = max(0, v); store.setDevice(d)
            }.frame(width: 70)
            LabNumberField(title: "MM H", value: store.document.device.physicalHeightMM) { v in
                var d = store.document.device; d.physicalHeightMM = max(0, v); store.setDevice(d)
            }.frame(width: 70)
        }
        Toggle("Ruler", isOn: $store.showRuler).toggleStyle(.button)

        Divider().frame(height: 26)

        Toggle("Grid", isOn: $store.showGrid).toggleStyle(.button)
        Toggle("Snap", isOn: $store.snapToGrid).toggleStyle(.button)
        Toggle("Reach", isOn: Binding(
            get: { store.document.reach.show },
            set: { on in store.document.reach.show = on; store.save() }
        )).toggleStyle(.button)

        Picker("Hand", selection: Binding(
            get: { store.document.reach.hand },
            set: { store.document.reach.hand = $0; store.save() }
        )) {
            Text("Right").tag("right")
            Text("Left").tag("left")
            Text("Centre").tag("centre")
        }
        .pickerStyle(.segmented)
        .frame(width: 210)

        HStack(spacing: 6) {
            LabNumberField(title: "THUMB MM", value: store.document.reach.comfortableMM) { v in
                store.document.reach.comfortableMM = max(20, v); store.save()
            }.frame(width: 84)
            LabNumberField(title: "STRETCH", value: store.document.reach.stretchMM) { v in
                store.document.reach.stretchMM = max(20, v); store.save()
            }.frame(width: 74)
        }
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
                            store.selection = []
                        }
                    } label: {
                        HStack(spacing: 7) {
                            Text(screen.name).font(.system(size: 13, weight: .bold))
                            Text("\(screen.instances.count)")
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
                        .foregroundStyle(LabColor.ink).padding(9)
                        .background(Circle().fill(.white).overlay(Circle().stroke(LabColor.ink, lineWidth: 1.5)))
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
        }
        .background(LabColor.paper)
    }
}
