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

/// Makes the app audible with the ring switch set to silent.
///
/// Nothing here ever configured an audio session, so everything spoken used
/// the default `.soloAmbient` category — which is silenced by the hardware
/// switch. That reads as "Preview voice is broken", and it is: it is also
/// every turn of spoken guidance going missing on a phone that happens to be
/// on silent, which is most phones, in a car, where the whole point is not
/// looking at the screen.
///
/// `.playback` plays regardless of the switch. `.spokenAudio` tells the system
/// this is speech rather than music, so CarPlay and Bluetooth treat it
/// correctly, and `.duckOthers` lowers the podcast instead of fighting it.
enum TimiAudioSession {
    static func activateForSpeech() {
        #if canImport(AVFoundation) && os(iOS) && !SKIP
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
            try session.setActive(true, options: [])
        } catch {
            // Audible-but-wrong beats silent-and-correct: if the category will
            // not take, speaking anyway may still be heard.
        }
        #endif
    }

    static func release() {
        #if canImport(AVFoundation) && os(iOS) && !SKIP
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        #endif
    }
}

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

    /// Voices worth offering, best first.
    ///
    /// `speechVoices()` returns everything the system has, and on iOS that
    /// still includes the 1980s Macintosh novelty set — Grandpa, Zarvox,
    /// Bells, Bubbles, Trinoids. They are all `.default` quality, they sound
    /// like a joke, and offering them beside a real voice in a driving app
    /// makes the whole picker look broken.
    ///
    /// So: enhanced and premium only, which is exactly the line between a
    /// downloaded high-quality voice and a compact fallback. If the phone has
    /// none installed, the list falls back to the compact voices rather than
    /// being empty — `bestVoice` still has something to return, and the
    /// picker says where to get better ones.
    public static func availableVoices(languagePrefix: String = Locale.current.language.languageCode?.identifier ?? "en") -> [AVSpeechSynthesisVoice] {
        let all = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(languagePrefix) }
        let good = all.filter { $0.quality == .enhanced || $0.quality == .premium }
        return (good.isEmpty ? all.filter { !isNovelty($0) } : good)
            .sorted { rank(of: $0.quality) > rank(of: $1.quality) }
    }

    /// Named rather than inferred: these carry no marker distinguishing them
    /// from a plain compact voice, so the only way to exclude them is to know
    /// them.
    private static let noveltyNames: Set<String> = [
        "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Wobble",
        "Eddy", "Flo", "Fred", "Good News", "Grandma", "Grandpa", "Jester", "Junior",
        "Kathy", "Organ", "Reed", "Ralph", "Rocko", "Sandy", "Shelley", "Superstar",
        "Trinoids", "Whisper", "Zarvox"
    ]

    private static func isNovelty(_ voice: AVSpeechSynthesisVoice) -> Bool {
        noveltyNames.contains(where: { voice.name.hasPrefix($0) })
    }

    /// Whether the phone has any high-quality voice installed, so the picker
    /// can say so instead of silently offering the compact ones.
    public static func hasHighQualityVoice(languagePrefix: String = Locale.current.language.languageCode?.identifier ?? "en") -> Bool {
        AVSpeechSynthesisVoice.speechVoices()
            .contains { $0.language.hasPrefix(languagePrefix) && ($0.quality == .enhanced || $0.quality == .premium) }
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
        // The preview must sound like the drive will. For the Tími natural
        // profile that means the voice gateway's audio, not AVSpeech doing an
        // impression of it; the device path below stays the fallback when
        // the fetch fails (offline, unconfigured gateway).
        if preferences.voiceProfile == .timiNatural {
            previewNatural(text: text, preferences: preferences)
            return
        }
        previewOnDevice(text: text, preferences: preferences)
    }

    private var naturalPlayer: AVAudioPlayer?

    private func previewNatural(text: String, preferences: NavigationPreferences) {
        var components = URLComponents(string: "\(TimiEnvironment.voiceGatewayURL)/api/nav-tts")
        components?.queryItems = [URLQueryItem(name: "text", value: text), URLQueryItem(name: "tone", value: "calm")]
        guard let url = components?.url else {
            previewOnDevice(text: text, preferences: preferences)
            return
        }
        Task { [weak self] in
            var request = URLRequest(url: url)
            request.timeoutInterval = 8
            if let (data, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200,
               let player = try? AVAudioPlayer(data: data) {
                TimiAudioSession.activateForSpeech()
                self?.naturalPlayer = player
                player.play()
            } else {
                self?.previewOnDevice(text: text, preferences: preferences)
            }
        }
    }

    private func previewOnDevice(text: String, preferences: NavigationPreferences) {
        TimiAudioSession.activateForSpeech()
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
// @_spi(MapboxInternal), not a plain import: `SystemSpeechSynthesizer` — the
// on-device voice, used below when the map token is absent or the on-device
// profile is chosen — is declared `@_spi(MapboxInternal) public` in the SDK,
// so a plain import leaves it out of scope entirely ("cannot find
// 'SystemSpeechSynthesizer' in scope", from a symbol that is plainly there in
// the sources). MapboxNavigationCore is a source package, not a binary one, so
// the SPI is compiled with the rest of it and nothing extra is needed.
//
// The alternative is writing our own AVSpeechSynthesizer-backed
// SpeechSynthesizing. Not worth it: Mapbox's handles AVAudioSession
// activation, ducking, and deactivation ordering, which is exactly the code
// you do not want to be debugging from a car.
@_spi(MapboxInternal) import MapboxNavigationCore
import MapboxDirections
import Combine

/// The Tími natural voice for turn-by-turn: audio synthesized by the voice
/// gateway's `/api/nav-tts` (the same Gemini voice the clinic phone calls
/// speak), prefetched ahead of each maneuver and played from memory.
///
/// Designed around `MultiplexedSpeechSynthesizer`'s fallback contract: this
/// synthesizer NEVER blocks a maneuver on the network. `speak` plays only
/// audio that is already cached; a cache miss publishes `EncounteredError`,
/// which is Multiplexed's cue to hand the line to the next synthesizer in
/// the chain (the on-device voice) — and the miss also starts the fetch, so
/// the next occurrence of that line is natural. Turn instructions repeat
/// heavily and `prepareIncomingSpokenInstructions` prefetches the next few,
/// so in practice the device voice is only heard offline or in the first
/// seconds of a drive.
@MainActor
final class TimiNaturalSpeechSynthesizer: NSObject, SpeechSynthesizing, AVAudioPlayerDelegate {
    private let _voiceInstructions = PassthroughSubject<VoiceInstructionEvent, Never>()
    public var voiceInstructions: AnyPublisher<VoiceInstructionEvent, Never> { _voiceInstructions.eraseToAnyPublisher() }
    public var muted = false {
        didSet { if muted { stopSpeaking() } }
    }
    public var volume: VolumeMode = .system {
        didSet { applyVolume() }
    }
    public var isSpeaking: Bool { player?.isPlaying ?? false }
    public var locale: Locale? = Locale.autoupdatingCurrent
    public var managesAudioSession = true
    /// Which register the gateway is asked to speak in; updated per trip via
    /// `TimiSpeechSynthesizer.beginTrip`.
    var tone: NavigationTone = .calm

    private let endpoint: URL
    /// Small LRU of synthesized lines. Keys carry the tone: "turn left" read
    /// calmly and read urgently are different audio.
    private var audioCache: [String: Data] = [:]
    private var cacheOrder: [String] = []
    private var inFlight: Set<String> = []
    private var player: AVAudioPlayer?
    private var currentInstruction: SpokenInstruction?

    init(endpoint: URL) {
        self.endpoint = endpoint
        super.init()
    }

    private func cacheKey(_ text: String) -> String { "\(tone.rawValue)|\(text)" }

    private func requestURL(for text: String) -> URL? {
        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "text", value: text),
            URLQueryItem(name: "tone", value: tone.rawValue)
        ]
        return components?.url
    }

    /// Kicks off a download unless the line is cached or already being
    /// fetched. The 260-character cap mirrors the endpoint's own.
    private func prefetch(_ text: String) {
        let key = cacheKey(text)
        guard !text.isEmpty, text.count <= 260, audioCache[key] == nil, !inFlight.contains(key),
              let url = requestURL(for: text) else { return }
        inFlight.insert(key)
        Task { [weak self] in
            defer { self?.inFlight.remove(key) }
            var request = URLRequest(url: url)
            request.timeoutInterval = 8
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else { return }
            guard let self else { return }
            self.audioCache[key] = data
            self.cacheOrder.append(key)
            // ~24 lines of WAV is a few megabytes; older lines re-fetch.
            while self.cacheOrder.count > 24 {
                self.audioCache.removeValue(forKey: self.cacheOrder.removeFirst())
            }
        }
    }

    public func prepareIncomingSpokenInstructions(_ instructions: [SpokenInstruction], locale: Locale?) {
        for instruction in instructions.prefix(4) { prefetch(instruction.text) }
    }

    public func speak(_ instruction: SpokenInstruction, during legProgress: RouteLegProgress, locale: Locale?) {
        guard !muted else { return }
        // Re-issuing the line already playing restarts it. `RouteVoiceController`
        // speaks whatever the navigator reports as the current instruction, and
        // the navigator refills that field from its own status updates, so a
        // repeat is cheap for it to send and expensive here: every repeat would
        // stop the player and start the sentence again, and a sentence that
        // restarts every second is never heard to the end.
        if isSpeaking, currentInstruction?.text == instruction.text { return }
        currentInstruction = instruction
        guard let data = audioCache[cacheKey(instruction.text)] else {
            // Not cached: this line goes to the fallback voice NOW (a
            // maneuver cannot wait on a network round trip), and the fetch
            // starts so the next time this line comes up it is natural.
            prefetch(instruction.text)
            _voiceInstructions.send(VoiceInstructionEvents.EncounteredError(
                error: .noData(instruction: instruction, options: SpeechOptions(text: instruction.text, locale: locale ?? .current))
            ))
            return
        }
        do {
            if managesAudioSession { TimiAudioSession.activateForSpeech() }
            player?.stop()
            let newPlayer = try AVAudioPlayer(data: data)
            newPlayer.delegate = self
            player = newPlayer
            applyVolume()
            _voiceInstructions.send(VoiceInstructionEvents.WillSpeak(instruction: instruction))
            newPlayer.play()
        } catch {
            _voiceInstructions.send(VoiceInstructionEvents.EncounteredError(
                error: .noData(instruction: instruction, options: SpeechOptions(text: instruction.text, locale: locale ?? .current))
            ))
        }
    }

    private func applyVolume() {
        if case .override(let level) = volume { player?.volume = level }
    }

    public func stopSpeaking() {
        player?.stop()
        finishPlayback()
    }

    public func interruptSpeaking() { stopSpeaking() }

    private func finishPlayback() {
        // The audio session is NOT released here, and that is the fix for a
        // real defect rather than an omission. Releasing per line meant
        // `setActive(false)` ran at the end of every utterance — including
        // from `stopSpeaking()`, which `MultiplexedSpeechSynthesizer` calls on
        // every synthesizer in the chain, so finishing a Tími line could
        // deactivate the session out from under the device voice that was
        // mid-sentence on the fallback path. It also re-negotiated the session
        // with every maneuver, which is the kind of churn that makes guidance
        // audible on one turn and silent on the next. The drive claims the
        // session once in `TimiNavigationSession.start` and gives it back once
        // in `TimiNavigationStack.endTrip`.
        if let instruction = currentInstruction {
            _voiceInstructions.send(VoiceInstructionEvents.DidSpeak(instruction: instruction))
        }
        currentInstruction = nil
        player = nil
    }

    // AVAudioPlayerDelegate is not MainActor-isolated; hop back before
    // touching state or publishing events.
    public nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in self?.finishPlayback() }
    }
}

/// Wraps Mapbox's standard "cloud voice primary, on-device fallback"
/// arrangement and rewrites every instruction through
/// `TimiInstructionRewriter` before it is ever spoken. Both `text` (read by
/// the on-device voice) and `ssmlText` (read by the cloud voice) are
/// rewritten identically so the two paths never say different things.
@MainActor
public final class TimiSpeechSynthesizer: SpeechSynthesizing {
    private let inner: MultiplexedSpeechSynthesizer
    /// Held so `beginTrip` can retune the register the gateway speaks in;
    /// nil for the profiles that never touch it.
    private let naturalSynthesizer: TimiNaturalSpeechSynthesizer?
    // Per-trip, and therefore variable. These were constants, which meant a new
    // synthesizer — and so a new MapboxNavigationProvider — for every drive.
    // See TimiNavigationStack: one provider is all the SDK supports.
    private var clinicName: String
    private var petName: String
    private var clinicKind: String?
    /// Which register this trip speaks in — set from the care urgency, so an
    /// emergency run never hears a joke.
    private var tone: NavigationTone
    /// The "look for the entrance" line is worth saying once, not on every
    /// instruction inside the last 400 metres.
    private var announcedApproach = false

    /// Points the voice at a different drive without rebuilding anything.
    ///
    /// The alternative is a new synthesizer per trip, which means a new
    /// provider per trip, which is the one thing the navigation SDK does not
    /// allow. `announcedApproach` resets here because it is the one piece of
    /// state that genuinely belongs to a single journey.
    public func beginTrip(clinicName: String, petName: String, clinicKind: String?, tone: NavigationTone) {
        self.clinicName = clinicName
        self.petName = petName
        self.clinicKind = clinicKind
        self.tone = tone
        naturalSynthesizer?.tone = tone
        announcedApproach = false
    }

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
        switch preferences.voiceProfile {
        case .timiNatural:
            // The default: Tími's own natural voice from the voice gateway,
            // with the device voice picking up any line the cache misses —
            // see TimiNaturalSpeechSynthesizer for the no-blocking contract.
            if let endpoint = URL(string: "\(TimiEnvironment.voiceGatewayURL)/api/nav-tts") {
                let natural = TimiNaturalSpeechSynthesizer(endpoint: endpoint)
                natural.tone = tone
                self.naturalSynthesizer = natural
                self.inner = MultiplexedSpeechSynthesizer(speechSynthesizers: [natural, SystemSpeechSynthesizer()])
            } else {
                self.naturalSynthesizer = nil
                self.inner = MultiplexedSpeechSynthesizer(speechSynthesizers: [SystemSpeechSynthesizer()])
            }
        case .mapboxCloud where !mapToken.isEmpty:
            self.naturalSynthesizer = nil
            self.inner = MultiplexedSpeechSynthesizer(
                mapboxSpeechApiConfiguration: ApiConfiguration(accessToken: mapToken),
                skuTokenProvider: { nil }
            )
        default:
            self.naturalSynthesizer = nil
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

/// `TimiSpeechSynthesizer` is `@MainActor`, as `SpeechSynthesizing` requires,
/// so anything that constructs one has to be too — a plain static factory is
/// nonisolated and fails with "call to main actor-isolated initializer in a
/// synchronous nonisolated context". The only caller is a UIViewController
/// method, which is already on the main actor.
@MainActor
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
