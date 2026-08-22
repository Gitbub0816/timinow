import Foundation
import TimiNowCore

// MARK: - Data-driven phrase rewriting (cross-platform, Skip-safe)
//
// Mirrors the web client's table in `public/map.js` (`INSTRUCTION_PHRASES` /
// `TIMI_ANNOUNCEMENTS`) word for word, loaded from a bundled JSON resource
// (`Resources/instruction-phrases.json`) so wording can change without a
// Swift recompile. Falls back to `InstructionPhraseTable.fallback` — a
// Swift-literal copy of the same table — if the resource is ever missing.
public enum TimiInstructionRewriter {
    private static let cachedTable: InstructionPhraseTable = loadTable()

    private static func loadTable() -> InstructionPhraseTable {
        guard let url = Bundle.module.url(forResource: "instruction-phrases", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let table = try? JSONDecoder().decode(InstructionPhraseTable.self, from: data)
        else { return .fallback }
        return table
    }

    /// Fills `{key}` placeholders from `values`. A missing or blank value
    /// leaves the placeholder token untouched — matching `map.js`'s `fill()`
    /// behavior exactly, so an unmapped maneuver never renders a half-empty
    /// sentence.
    static func fill(_ template: String, values: [String: String]) -> String {
        var result = template
        for (key, value) in values {
            let token = "{\(key)}"
            guard result.contains(token) else { continue }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { result = result.replacingOccurrences(of: token, with: trimmed) }
        }
        return result
    }

    /// Rewrites one turn-by-turn instruction from Mapbox's maneuver `type`
    /// (`depart`, `turn`, `arrive`, ...). Returns `nil` — keep Mapbox's own
    /// wording — when the maneuver has no entry in the table, exactly like
    /// `map.js`'s `phraseInstruction`.
    public static func phraseInstruction(maneuverType: String, modifier: String, road: String, clinicName: String, table: InstructionPhraseTable = cachedTable) -> String? {
        guard let template = table.instructionPhrases[maneuverType] else { return nil }
        let filled = fill(template, values: ["modifier": modifier, "road": road, "clinic": clinicName])
        return filled.replacingOccurrences(of: "  ", with: " ").trimmingCharacters(in: .whitespaces)
    }

    /// One of Tími's own announcements (`start` / `halfway` / `approaching`
    /// / `arrival`) that Mapbox would never say on its own.
    public static func announcement(_ key: String, clinicName: String, petName: String, minutes: Int? = nil, kind: String? = nil, table: InstructionPhraseTable = cachedTable) -> String? {
        guard let template = table.timiAnnouncements[key] else { return nil }
        var values = ["clinic": clinicName, "pet": petName]
        if let minutes { values["minutes"] = String(minutes) }
        if let kind { values["kind"] = kind }
        return fill(template, values: values)
    }
}

// MARK: - On-device voice (AVFoundation only — usable with or without Mapbox)

#if os(iOS) && !SKIP
import AVFoundation

/// Enumerates voices for the settings picker and drives the "Preview
/// voice" button. Uses only system AVFoundation APIs, so it works even in
/// a build without the Mapbox Navigation SDK.
@MainActor
public final class VoicePreviewer: NSObject, AVSpeechSynthesizerDelegate {
    public static let shared = VoicePreviewer()
    private let synthesizer = AVSpeechSynthesizer()

    override private init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Voices available for the app's language, enhanced/premium/personal
    /// tiers first so the best-quality option is easiest to pick.
    public static func availableVoices(languagePrefix: String = Locale.current.language.languageCode?.identifier ?? "en") -> [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(languagePrefix) }
            .sorted { rank(of: $0.quality) > rank(of: $1.quality) }
    }

    private static func rank(of quality: AVSpeechSynthesisVoiceQuality) -> Int {
        switch quality {
        case .premium: return 3
        case .enhanced: return 2
        default: return 1
        }
    }

    /// iOS 17+ Personal Voice must be explicitly authorized before it shows
    /// up in `speechVoices()`.
    public static func requestPersonalVoiceAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            AVSpeechSynthesizer.requestPersonalVoiceAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    public func preview(text: String, preferences: NavigationPreferences) {
        let utterance = AVSpeechUtterance(string: text)
        if let identifier = preferences.preferredVoiceIdentifier, let voice = AVSpeechSynthesisVoice(identifier: identifier) {
            utterance.voice = voice
        } else {
            utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
        }
        utterance.rate = Float(preferences.speechRate)
        utterance.pitchMultiplier = Float(preferences.speechPitch)
        synthesizer.stopSpeaking(at: .immediate)
        synthesizer.speak(utterance)
    }
}
#endif

// MARK: - Mapbox voice stack (cloud primary, on-device fallback)
//
// VERIFIED against a local clone of mapbox-navigation-ios
// (Sources/MapboxNavigationCore/VoiceGuidance/SpeechSynthesizing.swift):
// the full `SpeechSynthesizing` protocol shape below, `TTSConfig`, and
// `MultiplexedSpeechSynthesizer(speechSynthesizers:)`'s signature are
// accurate as of that read. `MapboxSpeechSynthesizer()`'s exact
// initializer (whether it needs an explicit access token or reads one
// from the active `CoreConfig`/`Credentials`) and `SpokenInstruction`'s
// mutability were NOT independently re-verified here — confirm both
// against the installed SDK version before shipping.
#if canImport(MapboxNavigationCore) && os(iOS) && !SKIP
import MapboxNavigationCore
import Combine

/// Wraps Mapbox's standard "cloud voice primary, on-device fallback"
/// arrangement and rewrites every instruction through
/// `TimiInstructionRewriter` before it is ever spoken. Both `text` (read by
/// the on-device voice) and `ssmlText` (read by the cloud voice) are
/// rewritten identically so the two paths never say different things.
@MainActor
public final class TimiSpeechSynthesizer: SpeechSynthesizing {
    private let inner: MultiplexedSpeechSynthesizer
    private let clinicName: String
    private let petName: String
    private let clinicKind: String?

    public var voiceInstructions: AnyPublisher<VoiceInstructionEvent, Never> { inner.voiceInstructions }
    public var muted: Bool {
        get { inner.muted }
        set { inner.muted = newValue }
    }
    public var volume: VolumeMode {
        get { inner.volume }
        set { inner.volume = newValue }
    }
    public var isSpeaking: Bool { inner.isSpeaking }
    public var locale: Locale? {
        get { inner.locale }
        set { inner.locale = newValue }
    }
    public var managesAudioSession: Bool {
        get { inner.managesAudioSession }
        set { inner.managesAudioSession = newValue }
    }

    public init(preferences: NavigationPreferences, clinicName: String, petName: String, clinicKind: String?) {
        self.clinicName = clinicName
        self.petName = petName
        self.clinicKind = clinicKind
        var speakers: [any SpeechSynthesizing] = []
        if preferences.voiceProfile == .mapboxCloud {
            speakers.append(MapboxSpeechSynthesizer())
        }
        speakers.append(SystemSpeechSynthesizer())
        self.inner = MultiplexedSpeechSynthesizer(speechSynthesizers: speakers)
    }

    public func prepareIncomingSpokenInstructions(_ instructions: [SpokenInstruction], locale: Locale?) {
        // Pre-fetch/caching hook only — spoken text is finalized in
        // `speak(_:during:locale:)`, where step/maneuver context is
        // available for the rewrite.
        inner.prepareIncomingSpokenInstructions(instructions, locale: locale)
    }

    public func speak(_ instruction: SpokenInstruction, during legProgress: RouteLegProgress, locale: Locale?) {
        inner.speak(rewritten(instruction, legProgress: legProgress), during: legProgress, locale: locale)
    }

    public func stopSpeaking() { inner.stopSpeaking() }
    public func interruptSpeaking() { inner.interruptSpeaking() }

    /// Text-based detection (rather than pattern-matching Mapbox's
    /// `ManeuverType` enum, whose exact case names differ across SDK
    /// versions) keeps this robust across Mapbox Navigation SDK point
    /// releases: any instruction that already talks about arriving is
    /// replaced with Tími's arrival announcement; anything within ~400 m of
    /// the clinic — read from `legProgress.distanceRemaining`, which has
    /// been stable API across Navigation SDK versions — gets Tími's
    /// "approaching" line appended once.
    private func rewritten(_ instruction: SpokenInstruction, legProgress: RouteLegProgress) -> SpokenInstruction {
        var copy = instruction
        let isArrival = instruction.text.localizedCaseInsensitiveContains("arrive")
            || instruction.text.localizedCaseInsensitiveContains("destination")
        if isArrival, let arrival = TimiInstructionRewriter.announcement("arrival", clinicName: clinicName, petName: petName) {
            copy.text = arrival
            copy.ssmlText = arrival
            return copy
        }
        if legProgress.distanceRemaining < 400, let approaching = TimiInstructionRewriter.announcement("approaching", clinicName: clinicName, petName: petName, kind: clinicKind ?? "clinic") {
            copy.text = instruction.text + " " + approaching
            copy.ssmlText = instruction.ssmlText + " " + approaching
        }
        return copy
    }
}

enum TimiSpeechStack {
    static func makeSynthesizer(preferences: NavigationPreferences, clinicName: String, petName: String, clinicKind: String?) -> TimiSpeechSynthesizer {
        TimiSpeechSynthesizer(preferences: preferences, clinicName: clinicName, petName: petName, clinicKind: clinicKind)
    }
}
#endif
