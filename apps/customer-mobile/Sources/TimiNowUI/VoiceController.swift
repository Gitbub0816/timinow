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

    /// Fill `{key}` placeholders.
    ///
    /// Returns nil when any placeholder cannot be resolved — matching
    /// `map.js`'s `fill()` exactly. A half-filled instruction is worse than
    /// none: the caller falls back to the navigation SDK's own wording, which
    /// is always complete even when it is less warm.
    static func fill(_ template: String, values: [String: String]) -> String? {
        var result = ""
        var complete = true
        var remainder = Substring(template)

        while let open = remainder.firstIndex(of: "{") {
            guard let close = remainder[open...].firstIndex(of: "}") else { break }
            result += remainder[remainder.startIndex..<open]
            let key = String(remainder[remainder.index(after: open)..<close])
            let value = (values[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if value.isEmpty { complete = false } else { result += value }
            remainder = remainder[remainder.index(after: close)...]
        }
        result += remainder

        guard complete else { return nil }
        while result.contains("  ") { result = result.replacingOccurrences(of: "  ", with: " ") }
        return result.trimmingCharacters(in: .whitespaces)
    }

    /// Rewrite one turn-by-turn instruction from Mapbox's maneuver `type`
    /// (`depart`, `turn`, `arrive`, ...) and direction. Returns nil — keep
    /// Mapbox's own wording — when the table cannot produce a whole sentence.
    public static func phraseInstruction(
        maneuverType: String,
        modifier: String,
        road: String,
        clinicName: String,
        // Defaulted to nil rather than to `cachedTable`: a default argument is
        // evaluated at the call site, so a public function cannot name a
        // private member there. The seam stays open for tests either way.
        table: InstructionPhraseTable? = nil
    ) -> String? {
        let table = table ?? cachedTable
        let key = modifier.lowercased()
        let template = table.instructionOverrides["\(maneuverType):\(key)"]
            ?? table.instructionPhrases[maneuverType]
        guard let template else { return nil }
        return fill(template, values: [
            "modifier": table.modifierWords[key] ?? key,
            "side": table.sideWords[key] ?? "",
            "road": road,
            "clinic": clinicName
        ])
    }

    /// One of Tími's own announcements (`start` / `halfway` / `approaching` /
    /// `arrival`), in the register the trip's urgency calls for.
    public static func announcement(
        _ key: String,
        tone: NavigationTone,
        clinicName: String,
        petName: String,
        minutes: Int? = nil,
        kind: String? = nil,
        table: InstructionPhraseTable? = nil
    ) -> String? {
        let table = table ?? cachedTable
        let register = table.timiAnnouncements[tone.rawValue]
            ?? table.timiAnnouncements[NavigationTone.calm.rawValue]
        guard let template = register?[key] else { return nil }
        var values = ["clinic": clinicName, "pet": petName]
        if let minutes { values["minutes"] = String(minutes) }
        if let kind { values["kind"] = kind }
        return fill(template, values: values)
    }

    /// Wrap a line in SSML so a cloud voice breathes instead of sprinting.
    ///
    /// Navigation text-to-speech defaults are tuned for terse maneuvers; Tími's
    /// announcements are whole sentences, and at the default rate they land as
    /// one anxious run-on. A short pause at each sentence boundary and a
    /// slightly relaxed rate is most of what makes a synthetic voice sound
    /// human. The emergency register keeps full pace.
    public static func ssml(for text: String, tone: NavigationTone) -> String {
        let rate: String
        switch tone {
        case .emergency: rate = "100%"
        case .urgent: rate = "97%"
        case .calm: rate = "94%"
        }
        var escaped = text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        for terminator in [". ", "! ", "? "] {
            escaped = escaped.replacingOccurrences(
                of: terminator,
                with: "\(terminator.prefix(1))<break time=\"320ms\"/> "
            )
        }
        return "<speak><prosody rate=\"\(rate)\">\(escaped)</prosody></speak>"
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

    /// A picker label that names the quality tier, because "Samantha" and
    /// "Samantha" are otherwise indistinguishable in a list even though one is
    /// a compact voice and the other is a 200 MB premium download.
    public static func label(for voice: AVSpeechSynthesisVoice) -> String {
        switch voice.quality {
        case .premium: return "\(voice.name) — Premium"
        case .enhanced: return "\(voice.name) — Enhanced"
        default: return voice.name
        }
    }

    /// The best voice the device has for this language.
    ///
    /// `AVSpeechSynthesisVoice(language:)` returns the *default* voice, which is
    /// the compact one on most devices — the flat, clipped voice people
    /// recognise as "robotic". Picking the highest-quality installed voice
    /// instead is the single biggest difference between guidance that sounds
    /// synthetic and guidance that sounds like a person, and it costs nothing.
    public static func bestVoice(
        languagePrefix: String = Locale.current.language.languageCode?.identifier ?? "en"
    ) -> AVSpeechSynthesisVoice? {
        availableVoices(languagePrefix: languagePrefix).first
            ?? AVSpeechSynthesisVoice(language: Locale.current.identifier)
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
            utterance.voice = Self.bestVoice()
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
    /// Which register this trip speaks in — set from the care urgency, so an
    /// emergency run never hears a joke.
    private let tone: NavigationTone
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
        clinicKind: String?,
        tone: NavigationTone
    ) {
        self.clinicName = clinicName
        self.petName = petName
        self.clinicKind = clinicKind
        self.tone = tone
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
           let arrival = TimiInstructionRewriter.announcement(
               "arrival",
               tone: tone,
               clinicName: clinicName,
               petName: petName
           ) {
            return SpokenInstruction(
                distanceAlongStep: instruction.distanceAlongStep,
                text: arrival,
                ssmlText: TimiInstructionRewriter.ssml(for: arrival, tone: tone)
            )
        }

        var text = instruction.text

        if let phrased = TimiInstructionRewriter.phraseInstruction(
            maneuverType: maneuver,
            modifier: step.maneuverDirection?.rawValue ?? "",
            road: step.names?.first ?? roadName(from: step),
            clinicName: clinicName
        ) {
            text = phrased
        }

        // Said once, on the last leg, so the driver knows what to look for
        // before they need to look for it.
        if legProgress.distanceRemaining < 400,
           !announcedApproach,
           let approaching = TimiInstructionRewriter.announcement(
               "approaching",
               tone: tone,
               clinicName: clinicName,
               petName: petName,
               kind: clinicKind ?? "clinic"
           ) {
            announcedApproach = true
            text += " " + approaching
        }

        // The SSML is generated from the finished sentence rather than patched
        // alongside it, so the cloud voice and the on-device voice can never
        // end up saying two different things.
        return SpokenInstruction(
            distanceAlongStep: instruction.distanceAlongStep,
            text: text,
            ssmlText: TimiInstructionRewriter.ssml(for: text, tone: tone)
        )
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
        clinicKind: String?,
        tone: NavigationTone
    ) -> TimiSpeechSynthesizer {
        TimiSpeechSynthesizer(
            preferences: preferences,
            mapToken: mapToken,
            clinicName: clinicName,
            petName: petName,
            clinicKind: clinicKind,
            tone: tone
        )
    }
}
#endif
