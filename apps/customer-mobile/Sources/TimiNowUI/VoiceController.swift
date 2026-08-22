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
// Verified against a local clone of mapbox-navigation-ios at v3.27.3:
//
//   - `SpeechSynthesizing` is @MainActor, and `speak` is synchronous and
//     takes `during legProgress: RouteLegProgress`.
//   - `TTSConfig.custom(speechSynthesizer:)` is how a custom synthesizer is
//     installed, via `CoreConfig(ttsConfig:)`.
//   - `MapboxSpeechSynthesizer`'s initializer is INTERNAL to the SDK, so the
//     cloud voice cannot be constructed directly. The supported route is
//     `MultiplexedSpeechSynthesizer(mapboxSpeechApiConfiguration:skuTokenProvider:
//     customSpeechSynthesizers:)`, which builds the cloud synthesizer itself
//     and appends `SystemSpeechSynthesizer()` as the fallback.
//   - `SpokenInstruction` is constructed, not mutated, through its public
//     `init(distanceAlongStep:text:ssmlText:)`.
//   - `RouteStep.maneuverType` is a `String`-backed `ManeuverType` whose raw
//     values are exactly the keys used in `instruction-phrases.json`.
#if canImport(MapboxNavigationCore) && os(iOS) && !SKIP
import MapboxNavigationCore
import MapboxDirections
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
    /// The "look for the entrance" line is worth saying once, not on every
    /// instruction inside the last 400 metres.
    private var announcedApproach = false

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

    /// `mapToken` is the public Mapbox token from `GET /api/config`; it is only
    /// needed for the cloud voice, which is a billed Mapbox Speech request.
    ///
    /// `MapboxSpeechSynthesizer`'s own initializer is internal to the SDK, so
    /// the cloud voice can only be assembled through
    /// `MultiplexedSpeechSynthesizer`'s convenience initializer — that is the
    /// supported way to get "cloud first, on-device fallback". Choosing an
    /// on-device profile skips the cloud entirely, which also means no Mapbox
    /// Speech charges and no network dependency for guidance.
    public init(
        preferences: NavigationPreferences,
        mapToken: String,
        clinicName: String,
        petName: String,
        clinicKind: String?
    ) {
        self.clinicName = clinicName
        self.petName = petName
        self.clinicKind = clinicKind
        if preferences.voiceProfile == .mapboxCloud && !mapToken.isEmpty {
            self.inner = MultiplexedSpeechSynthesizer(
                mapboxSpeechApiConfiguration: ApiConfiguration(accessToken: mapToken),
                skuTokenProvider: { nil }
            )
        } else {
            self.inner = MultiplexedSpeechSynthesizer(speechSynthesizers: [SystemSpeechSynthesizer()])
        }
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

    /// Rewrite one spoken instruction into Tími's voice.
    ///
    /// The phrase table is keyed by Mapbox's own maneuver identifiers, which is
    /// not a coincidence: `ManeuverType` is a `String`-backed enum whose raw
    /// values are exactly `depart`, `turn`, `continue`, `new name`, `merge`,
    /// `on ramp`, `off ramp`, `fork`, `roundabout`, and `arrive` — the same
    /// keys the web client uses in `public/map.js`. Reading `rawValue` rather
    /// than pattern-matching case names keeps this working across SDK
    /// releases and lets one JSON file drive both clients.
    ///
    /// Both `text` and `ssmlText` are replaced. The cloud synthesizer speaks
    /// `ssmlText` and the on-device one speaks `text`, so rewriting only one
    /// would produce two voices saying two different things depending on
    /// network conditions.
    private func rewritten(_ instruction: SpokenInstruction, legProgress: RouteLegProgress) -> SpokenInstruction {
        let step = legProgress.currentStep
        let maneuver = step.maneuverType.rawValue

        // Arrival is special: Tími replaces the whole line rather than
        // rephrasing it, because the useful information is what to do at the
        // front desk, not that the drive is over.
        if maneuver == "arrive",
           let arrival = TimiInstructionRewriter.announcement("arrival", clinicName: clinicName, petName: petName) {
            return SpokenInstruction(
                distanceAlongStep: instruction.distanceAlongStep,
                text: arrival,
                ssmlText: arrival
            )
        }

        var text = instruction.text
        var ssml = instruction.ssmlText

        if let phrased = TimiInstructionRewriter.phraseInstruction(
            maneuverType: maneuver,
            modifier: step.maneuverDirection?.rawValue ?? "",
            road: step.names?.first ?? roadName(from: step),
            clinicName: clinicName
        ) {
            text = phrased
            ssml = phrased
        }

        // Said once, on the last leg, so the driver knows what to look for
        // before they need to look for it.
        if legProgress.distanceRemaining < 400,
           !announcedApproach,
           let approaching = TimiInstructionRewriter.announcement(
               "approaching",
               clinicName: clinicName,
               petName: petName,
               kind: clinicKind ?? "clinic"
           ) {
            announcedApproach = true
            text += " " + approaching
            ssml += " " + approaching
        }

        return SpokenInstruction(distanceAlongStep: instruction.distanceAlongStep, text: text, ssmlText: ssml)
    }

    /// Fall back to the road name embedded in Mapbox's own phrasing when the
    /// step carries no `names` array, which happens on unnamed service roads.
    private func roadName(from step: RouteStep) -> String {
        let instructions = step.instructions
        if let range = instructions.range(of: "onto ", options: .caseInsensitive) {
            return String(instructions[range.upperBound...])
        }
        if let range = instructions.range(of: " on ", options: .caseInsensitive) {
            return String(instructions[range.upperBound...])
        }
        return "the road"
    }
}

enum TimiSpeechStack {
    static func makeSynthesizer(
        preferences: NavigationPreferences,
        mapToken: String,
        clinicName: String,
        petName: String,
        clinicKind: String?
    ) -> TimiSpeechSynthesizer {
        TimiSpeechSynthesizer(
            preferences: preferences,
            mapToken: mapToken,
            clinicName: clinicName,
            petName: petName,
            clinicKind: clinicKind
        )
    }
}
#endif
