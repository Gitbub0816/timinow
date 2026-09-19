import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// "When I am done, let me export a configuration."
///
/// The configuration is the deliverable, so it is shown in full rather than
/// handed over as an opaque file: you can read it, copy it, share it, or
/// write it into the app's Documents folder where the Files app can reach it.
/// Import is here too — a configuration you cannot get back in is a dead end.
public struct LabExportView: View {
    @EnvironmentObject var store: LabStore
    @Environment(\.dismiss) private var dismiss

    @State private var json: String = ""
    @State private var savedURL: URL?
    @State private var importing = false
    @State private var importText = ""
    @State private var importFailed = false

    public init() {}

    public var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                summary
                Divider()
                if importing { importPane } else { exportPane }
            }
            .navigationTitle(importing ? "Import a configuration" : "Configuration")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(importing ? "Export" : "Import") {
                        importing.toggle()
                        importFailed = false
                    }
                }
            }
            .onAppear { json = store.exportJSON() }
        }
    }

    private var summary: some View {
        let screens = store.document.screens
        let total = screens.reduce(0) { $0 + $1.instances.count }
        return HStack(spacing: 22) {
            stat("\(store.document.components.count)", "components")
            stat("\(screens.count)", "screens")
            stat("\(total)", "placed")
            stat("\(Int(store.document.device.pointWidth))\u{00D7}\(Int(store.document.device.pointHeight))", "points")
            Spacer()
        }
        .padding(16)
    }

    private func stat(_ value: String, _ caption: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value).font(.system(size: 19, weight: .black)).monospacedDigit()
                .foregroundStyle(LabColor.ink)
            Text(caption.uppercased()).font(.system(size: 9, weight: .black)).tracking(1.2)
                .foregroundStyle(LabColor.muted)
        }
    }

    private var exportPane: some View {
        VStack(spacing: 0) {
            ScrollView([.vertical, .horizontal]) {
                Text(json)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
            }
            .background(LabColor.canvas)

            VStack(spacing: 8) {
                if let savedURL {
                    Text("Saved as \(savedURL.lastPathComponent) \u{2014} open the Files app, On My iPad, Layout Lab.")
                        .font(.system(size: 11)).foregroundStyle(LabColor.green)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if let error = store.lastError {
                    Text(error).font(.system(size: 11)).foregroundStyle(LabColor.coral)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                HStack(spacing: 10) {
                    Button {
                        #if canImport(UIKit)
                        UIPasteboard.general.string = json
                        #endif
                    } label: { Label("Copy", systemImage: "doc.on.doc") }
                        .buttonStyle(.borderedProminent)

                    Button { savedURL = store.writeExport() } label: {
                        Label("Save to Files", systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(.bordered)

                    ShareLink(item: json) { Label("Share", systemImage: "square.and.arrow.up") }
                        .buttonStyle(.bordered)
                    Spacer()
                }
            }
            .padding(14)
        }
    }

    private var importPane: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Paste a configuration exported from this app. It replaces everything currently open.")
                .font(.system(size: 12)).foregroundStyle(LabColor.muted)
            TextEditor(text: $importText)
                .font(.system(size: 11, design: .monospaced))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(LabColor.ink.opacity(0.25), lineWidth: 1.5))
            if importFailed {
                Text("That is not a configuration this app can read \u{2014} check it is the whole file, braces included.")
                    .font(.system(size: 11)).foregroundStyle(LabColor.coral)
            }
            HStack {
                Button("Replace everything") {
                    if store.importJSON(importText) { dismiss() } else { importFailed = true }
                }
                .buttonStyle(.borderedProminent)
                .disabled(importText.isEmpty)
                Spacer()
            }
        }
        .padding(14)
    }
}
