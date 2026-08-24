import Foundation
import TimiNowCore

#if canImport(MapboxNavigationCore) && os(iOS) && !SKIP
import MapboxNavigationCore

/// The app's one navigation provider.
///
/// `MapboxNavigationProvider` is not an object you make when you need one. It
/// owns the SDK's navigator, its tile store and its billing session, all of
/// which are process-wide, and the SDK is built on there being exactly one of
/// it for the lifetime of the app.
///
/// This app was making two, from two places, every time. `RoutePreviewFetcher`
/// built one to draw the route line on the tracker map, and
/// `NavigationHostController` built another the moment somebody pressed
/// Navigate — a fresh one on every press, because the provider carried the
/// trip's voice configuration and the voice knew the pet's name.
///
/// So the second construction is the interesting one, and it is worth being
/// precise about why it is not merely wasteful: the first provider has already
/// taken the process-wide navigator. The second cannot have it. What the SDK
/// does about that is not an error this code can catch — nothing is thrown,
/// nothing returns nil — and the app goes away, which is what pressing
/// Navigate has been doing.
///
/// One provider, made on first use and kept. What used to vary per trip — the
/// pet's name, the clinic, the register to speak in — is now handed to the
/// synthesizer through `beginTrip` instead of being baked in at construction.
/// `@MainActor` because `SpeechSynthesizing` is, and therefore so are
/// `TimiSpeechSynthesizer` and `TimiSpeechStack.makeSynthesizer` — see the note
/// above TimiSpeechSynthesizer. The provider is built alongside a synthesizer,
/// so this is built where that one has to be. Everything that calls it is
/// already there: `NavigationHostController` is a `UIViewController`, and the
/// preview fetcher awaits.
@MainActor
enum TimiNavigationStack {
    private static var provider: MapboxNavigationProvider?
    private static var synthesizer: TimiSpeechSynthesizer?
    private static var builtWithToken = ""

    /// The provider, built on the first call and returned unchanged after.
    ///
    /// `preferences` and the access token therefore apply as they were on that
    /// first call. Changing the voice or the avoid-tolls setting mid-session is
    /// worth a relaunch; constructing a second provider is worth an app that
    /// closes itself.
    static func shared(mapToken: String, preferences: NavigationPreferences) -> MapboxNavigationProvider {
        if let provider, builtWithToken == mapToken { return provider }

        let speech = preferences.voiceEnabled
            ? TimiSpeechStack.makeSynthesizer(
                preferences: preferences,
                mapToken: mapToken,
                clinicName: "the clinic",
                petName: "your pet",
                clinicKind: nil,
                tone: .calm
            )
            : nil
        let built = MapboxNavigationProvider(
            coreConfig: CoreConfig(
                credentials: NavigationCoreApiConfiguration(accessToken: mapToken),
                locale: Locale.current,
                ttsConfig: speech.map { TTSConfig.custom(speechSynthesizer: $0) } ?? .localOnly
            )
        )
        provider = built
        synthesizer = speech
        builtWithToken = mapToken
        return built
    }

    /// Tells the shared voice which drive it is about to narrate.
    static func beginTrip(clinicName: String, petName: String, clinicKind: String?, tone: NavigationTone) {
        synthesizer?.beginTrip(clinicName: clinicName, petName: petName, clinicKind: clinicKind, tone: tone)
    }
}
#endif
