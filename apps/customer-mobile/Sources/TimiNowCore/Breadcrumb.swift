import Foundation

/// Where the app was when it stopped being here.
///
/// A Swift crash — a trap, a failed precondition, a force-unwrap inside a
/// framework — cannot be caught in process. There is no `catch` for it, no
/// handler that runs reliably afterwards, and nothing reaches the Worker,
/// because the Worker is told about failures by code that no longer exists.
/// So the report has to be written *before* the crash and read *after* it.
///
/// A breadcrumb is one string in UserDefaults, written synchronously as the app
/// enters a stage it might not leave, and cleared when it leaves. If it is
/// still there at the next launch, the app died in that stage, and the next
/// launch says so. That is the whole mechanism, and it turns "it crashes when I
/// press Navigate" into "it died constructing the Mapbox provider" — which is
/// a fix rather than a search.
///
/// Deliberately not a crash reporter. It installs no signal handlers and
/// replaces nothing Apple provides; the .ips file iOS writes is still the
/// document with the stack trace in it. This is the part that gets off the
/// phone without anybody having to go looking.
public enum TimiBreadcrumb {
    private static let key = "timi.breadcrumb"

    #if !os(Android)
    private static var defaults: UserDefaults { .standard }
    #endif

    /// Entering something that might not return.
    ///
    /// `synchronize()` is deprecated and is called anyway: the documented
    /// replacement is periodic flushing, which is exactly the guarantee this
    /// needs and does not have — the process may be gone microseconds later.
    public static func mark(_ stage: String) {
        #if !os(Android)
        defaults.set(stage, forKey: key)
        defaults.synchronize()
        #endif
    }

    /// Left it alive.
    public static func clear() {
        #if !os(Android)
        defaults.removeObject(forKey: key)
        defaults.synchronize()
        #endif
    }

    /// A stage the last launch entered and never left, or nil for a clean exit.
    /// Reading it clears it, so one crash is reported once.
    public static func consume() -> String? {
        #if !os(Android)
        guard let stage = defaults.string(forKey: key), !stage.isEmpty else { return nil }
        clear()
        return stage
        #else
        return nil
        #endif
    }

    /// Runs `work`, clearing the breadcrumb only if it returns.
    public static func during<T>(_ stage: String, _ work: () throws -> T) rethrows -> T {
        mark(stage)
        defer { clear() }
        return try work()
    }
}
