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

/// The data-driven phrase table that turns Mapbox's generic instructions
/// into Tími's voice. Mirrors the shape and wording of the web client's
/// table in `public/map.js` (`INSTRUCTION_PHRASES` / `TIMI_ANNOUNCEMENTS`)
/// exactly, so the web and native clients speak identically. Loaded from a
/// bundled JSON resource (see `TimiInstructionRewriter` in
/// TimiNowUI/VoiceController.swift) so wording can change without touching
/// Swift source.
///
/// - `instructionPhrases` is keyed by Mapbox's maneuver `type` (`depart`,
///   `arrive`, `turn`, `merge`, `"on ramp"`, `"off ramp"`, `fork`,
///   `roundabout`, `continue`, `"new name"`) with `{modifier}` / `{road}` /
///   `{clinic}` placeholders.
/// - `timiAnnouncements` is keyed by `start` / `halfway` / `approaching` /
///   `arrival` with `{clinic}` / `{pet}` / `{minutes}` / `{kind}`
///   placeholders — sentences Tími adds that Mapbox would never say.
public struct InstructionPhraseTable: Codable, Hashable, Sendable {
    public var instructionPhrases: [String: String]
    public var timiAnnouncements: [String: String]

    public init(instructionPhrases: [String: String], timiAnnouncements: [String: String]) {
        self.instructionPhrases = instructionPhrases
        self.timiAnnouncements = timiAnnouncements
    }

    /// Matches `public/map.js` word for word so the web and native clients
    /// never drift, even if the bundled JSON resource fails to load.
    public static let fallback = InstructionPhraseTable(
        instructionPhrases: [
            "depart": "Head {modifier} on {road}",
            "arrive": "You've arrived at {clinic}",
            "turn": "Turn {modifier} onto {road}",
            "merge": "Merge {modifier} onto {road}",
            "on ramp": "Take the ramp {modifier} onto {road}",
            "off ramp": "Take the exit {modifier} toward {road}",
            "fork": "Keep {modifier} at the fork",
            "roundabout": "At the roundabout, take the exit onto {road}",
            "continue": "Continue on {road}",
            "new name": "Continue onto {road}"
        ],
        timiAnnouncements: [
            "start": "Heading to {clinic}. The team is expecting {pet}.",
            "halfway": "About {minutes} minutes to {clinic}.",
            "approaching": "{clinic} is coming up. Look for the {kind} entrance.",
            "arrival": "You've arrived at {clinic}. Tell the front desk you're the Tími arrival for {pet}."
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
