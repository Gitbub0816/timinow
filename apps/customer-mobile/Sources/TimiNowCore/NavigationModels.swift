import Foundation

// Skip-safe navigation models: plain Foundation types only, no Apple-only
// symbols (CoreLocation, MapboxMaps, etc.) so this file stays part of the
// public Skip bridge surface shared with the Android build.

public struct GeoPoint: Codable, Hashable, Sendable {
    public var latitude: Double
    public var longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }
}

public struct NavigationDestination: Identifiable, Codable, Hashable, Sendable {
    public var clinicId: String
    public var name: String
    public var address: String
    public var latitude: Double
    public var longitude: Double
    public var phone: String?
    /// The clinic's `kind` (e.g. "urgent", "emergency"), used to fill the
    /// `{kind}` placeholder in the "approaching" voice announcement.
    public var kind: String?

    public var id: String { clinicId }

    public init(clinicId: String, name: String, address: String, latitude: Double, longitude: Double, phone: String? = nil, kind: String? = nil) {
        self.clinicId = clinicId
        self.name = name
        self.address = address
        self.latitude = latitude
        self.longitude = longitude
        self.phone = phone
        self.kind = kind
    }
}

public struct RouteSummary: Codable, Hashable, Sendable {
    public var distanceMeters: Double
    public var expectedTravelSeconds: Double
    public var trafficDelaySeconds: Double

    public init(distanceMeters: Double, expectedTravelSeconds: Double, trafficDelaySeconds: Double = 0) {
        self.distanceMeters = distanceMeters
        self.expectedTravelSeconds = expectedTravelSeconds
        self.trafficDelaySeconds = trafficDelaySeconds
    }

    public var distanceMiles: Double { distanceMeters / 1609.344 }
    public var distanceKilometers: Double { distanceMeters / 1000 }
    public var expectedTravelMinutes: Int { Int((expectedTravelSeconds / 60).rounded()) }

    public func distanceText(units: DistanceUnits) -> String {
        switch units {
        case .imperial: return String(format: "%.1f mi", distanceMiles)
        case .metric: return String(format: "%.1f km", distanceKilometers)
        }
    }
}

public struct NavigationStepModel: Identifiable, Codable, Hashable, Sendable {
    public var id: String
    public var instruction: String
    public var distanceMeters: Double
    public var maneuver: String

    public init(id: String = UUID().uuidString, instruction: String, distanceMeters: Double, maneuver: String) {
        self.id = id
        self.instruction = instruction
        self.distanceMeters = distanceMeters
        self.maneuver = maneuver
    }
}

/// Which register Tími speaks in. Derived from the care urgency rather than a
/// preference: a driver on an emergency run should never have to have turned
/// something off to avoid a joke.
public enum NavigationTone: String, Codable, CaseIterable, Sendable {
    case calm
    case urgent
    case emergency

    public static func forUrgency(_ urgency: CareUrgency) -> NavigationTone {
        switch urgency {
        case .emergency: return .emergency
        case .urgent: return .urgent
        case .sameDay: return .calm
        }
    }
}

public enum VoiceProfile: String, Codable, CaseIterable, Sendable {
    case mapboxCloud = "mapbox_cloud"
    case systemDefault = "system_default"
    case systemEnhanced = "system_enhanced"
    case personalVoice = "personal_voice"

    public var title: String {
        switch self {
        case .mapboxCloud: return "Tími cloud voice"
        case .systemDefault: return "Device voice"
        case .systemEnhanced: return "Device voice (enhanced)"
        case .personalVoice: return "My Personal Voice"
        }
    }
}

public enum DistanceUnits: String, Codable, CaseIterable, Sendable {
    case imperial
    case metric
    public var title: String { self == .imperial ? "Miles" : "Kilometers" }
}

public struct NavigationPreferences: Codable, Hashable, Sendable {
    public var voiceEnabled: Bool
    public var voiceProfile: VoiceProfile
    public var distanceUnits: DistanceUnits
    public var avoidTolls: Bool
    public var avoidHighways: Bool
    public var avoidFerries: Bool
    public var announceArrivalAtClinic: Bool
    public var speechRate: Double
    public var speechPitch: Double
    public var preferredVoiceIdentifier: String?

    public init(
        voiceEnabled: Bool = true,
        voiceProfile: VoiceProfile = .mapboxCloud,
        distanceUnits: DistanceUnits = .imperial,
        avoidTolls: Bool = false,
        avoidHighways: Bool = false,
        avoidFerries: Bool = false,
        announceArrivalAtClinic: Bool = true,
        speechRate: Double = 0.5,
        speechPitch: Double = 1.0,
        preferredVoiceIdentifier: String? = nil
    ) {
        self.voiceEnabled = voiceEnabled
        self.voiceProfile = voiceProfile
        self.distanceUnits = distanceUnits
        self.avoidTolls = avoidTolls
        self.avoidHighways = avoidHighways
        self.avoidFerries = avoidFerries
        self.announceArrivalAtClinic = announceArrivalAtClinic
        self.speechRate = speechRate
        self.speechPitch = speechPitch
        self.preferredVoiceIdentifier = preferredVoiceIdentifier
    }

    public static let `default` = NavigationPreferences()
}

/// The data-driven phrase table that turns Mapbox's generic instructions into
/// Tími's voice.
///
/// Generated from the web client's table in `public/map.js` by
/// `npm run sync:phrases`, so the two clients speak identically; the Swift
/// literal below is a fallback for a missing bundle resource, and
/// `scripts/validate.mjs` fails the build if either copy drifts. Wording can
/// therefore change by editing one JavaScript file and re-running one command,
/// with no Swift edit at all.
///
/// Two rules govern the tone, and they are structural rather than stylistic:
/// maneuvers are never funny, because a driver gets one pass at them; and
/// personality scales inversely with urgency, so the `emergency` register
/// carries none.
public struct InstructionPhraseTable: Codable, Hashable, Sendable {
    /// Keyed by Mapbox's maneuver identifier (`turn`, `depart`, `arrive`, ...).
    public var instructionPhrases: [String: String]
    /// Keyed `"maneuver:modifier"`, for pairings the generic template cannot
    /// say naturally — "Take the U-turn onto Foothill" is not English.
    public var instructionOverrides: [String: String]
    /// Mapbox's raw direction values, said the way a person says them.
    public var modifierWords: [String: String]
    /// The same directions reduced to a side, for ramps, merges, and forks.
    public var sideWords: [String: String]
    /// Tími's own lines, keyed by register (`calm`, `urgent`, `emergency`)
    /// then by moment (`start`, `halfway`, `approaching`, `arrival`).
    public var timiAnnouncements: [String: [String: String]]

    public init(
        instructionPhrases: [String: String],
        instructionOverrides: [String: String],
        modifierWords: [String: String],
        sideWords: [String: String],
        timiAnnouncements: [String: [String: String]]
    ) {
        self.instructionPhrases = instructionPhrases
        self.instructionOverrides = instructionOverrides
        self.modifierWords = modifierWords
        self.sideWords = sideWords
        self.timiAnnouncements = timiAnnouncements
    }

    /// Generated from `public/map.js` by `npm run sync:phrases`, so the web and
    /// native clients speak identically even if the bundled resource fails to
    /// load. `scripts/validate.mjs` fails the build if this drifts.
    public static let fallback = InstructionPhraseTable(
        instructionPhrases: [
            "depart": "Off we go — head {side} on {road}",
            "arrive": "That's {clinic}, right there",
            "turn": "Take the {modifier} onto {road}",
            "merge": "Merge {side} onto {road}",
            "on ramp": "Hop on the ramp on the {side} toward {road}",
            "off ramp": "Take the exit on the {side} toward {road}",
            "fork": "Keep {side} at the fork",
            "roundabout": "Round the roundabout, then out onto {road}",
            "continue": "Stay on {road}",
            "new name": "Same road, new name — it's {road} now"
        ],
        instructionOverrides: [
            "turn:uturn": "Turn around when it's safe to",
            "turn:straight": "Keep straight onto {road}",
            "continue:uturn": "Turn around when it's safe to",
            "fork:straight": "Keep straight at the fork",
            "depart:uturn": "Start out by turning around when it's safe",
            "merge:straight": "Merge onto {road}",
            "on ramp:straight": "Hop on the ramp toward {road}",
            "off ramp:straight": "Take the exit toward {road}"
        ],
        modifierWords: [
            "left": "left",
            "right": "right",
            "slight left": "slight left",
            "slight right": "slight right",
            "sharp left": "sharp left",
            "sharp right": "sharp right",
            "straight": "straight ahead",
            "uturn": "U-turn"
        ],
        sideWords: [
            "left": "left",
            "right": "right",
            "slight left": "left",
            "slight right": "right",
            "sharp left": "left",
            "sharp right": "right",
            "straight": "straight",
            "uturn": "left"
        ],
        timiAnnouncements: [
            "calm": [
                "start": "Off we go. {clinic} is expecting {pet}, so the hard part is already behind you.",
                "halfway": "About {minutes} minutes out — and {pet} is in good paws from here.",
                "approaching": "{clinic} is just ahead. Look for the {kind} entrance.",
                "arrival": "You made it. Tell the front desk you're the Tími arrival for {pet}. Nicely done — that was a fetching bit of driving."
            ],
            "urgent": [
                "start": "On our way to {clinic}. They know {pet} is coming.",
                "halfway": "About {minutes} minutes to {clinic}. You're doing great.",
                "approaching": "{clinic} is just ahead. Look for the {kind} entrance.",
                "arrival": "You've arrived. Tell the front desk you're the Tími arrival for {pet}."
            ],
            "emergency": [
                "start": "Heading to {clinic} now. They are expecting {pet}. Drive safely.",
                "halfway": "{minutes} minutes to {clinic}.",
                "approaching": "{clinic} is ahead. Go to the {kind} entrance.",
                "arrival": "You've arrived. Go straight in and say {pet} is the Tími emergency arrival."
            ]
        ]
    )
}

/// `/api/config` → `map`, per docs/PLATFORM-CONTRACT.md. Extra top-level
/// keys on the config response (appName, clerkPublishableKey, ...) are
/// simply ignored by `JSONDecoder`.
public struct MapConfig: Codable, Hashable, Sendable {
    public var token: String?
    public var styleUrl: String?
    public var navigationStyleUrl: String?
}

public struct AppConfigEnvelope: Codable, Sendable {
    public var map: MapConfig?
}

/// Compiled-in defaults used until `GET /api/config` returns live values
/// (or when running against no Worker at all, in demo mode).
public enum MapDefaults {
    public static let styleURL = "mapbox://styles/calebowen2019/cmt3nci25004d01sya8qxcb4u"
}
