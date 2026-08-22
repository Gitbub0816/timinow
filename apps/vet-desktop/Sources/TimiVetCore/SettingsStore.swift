import Foundation

// Swift port of apps/vet-windows/src/TimiVet/Services/SettingsStore.cs.
//
// Persists to ~/Library/Application Support/ClearKey/TimiVet/settings.json.
// Unlike the Windows app, the Clerk bearer token is never written to this
// file — it lives only in the Keychain via KeychainStore. Launch-at-login is
// handled separately (TimiVetUI's AlertCenter, via SMAppService), since that
// API is AppKit/macOS-only and does not belong in the shared core.
public final class SettingsStore: @unchecked Sendable {
    private let directory: URL
    private var fileURL: URL { directory.appendingPathComponent("settings.json") }

    public init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        directory = base.appendingPathComponent("ClearKey", isDirectory: true).appendingPathComponent("TimiVet", isDirectory: true)
    }

    public func load() -> AppSettings {
        guard let data = try? Data(contentsOf: fileURL) else { return AppSettings() }
        return (try? JSONDecoder().decode(AppSettings.self, from: data)) ?? AppSettings()
    }

    public func save(_ settings: AppSettings) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(settings)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            // Best-effort, same as the Windows app: a failed write should not
            // crash the console — it just means settings are not persisted.
        }
    }
}
