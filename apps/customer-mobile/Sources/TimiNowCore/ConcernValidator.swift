import Foundation

public struct ConcernValidation: Equatable, Sendable {
    public var score: Int
    public var issues: [String]
    public var isReady: Bool { issues.isEmpty && score >= 70 }
}

/// When the concern began.
///
/// A closed set, not free text. The Worker validates `startedWhen` against
/// exactly these five tokens (`VALID_ONSETS` in src/index.js) and reads them
/// aloud to clinics through `humanizeOnset`, so anything else is rejected with
/// "Choose when the concern started." The phone app used to offer a text field
/// — "Example: around 7 AM today" — which meant no care request it sent could
/// ever be accepted, whatever anybody typed. The web form has had the right
/// dropdown all along (public/index.html), which is how the mismatch survived:
/// the surface being tested was not the surface being used.
public enum ConcernOnset: String, CaseIterable, Sendable {
    case withinHour = "within_hour"
    case today
    case oneToThreeDays = "one_to_three_days"
    case moreThanThreeDays = "more_than_three_days"
    case unknown

    /// Matching the web form's wording, so the two surfaces read the same.
    public var title: String {
        switch self {
        case .withinHour: return "Within the last hour"
        case .today: return "Earlier today"
        case .oneToThreeDays: return "1–3 days ago"
        case .moreThanThreeDays: return "More than 3 days ago"
        case .unknown: return "I'm not sure"
        }
    }
}

/// Mirrors the Worker's `concernSpecificity`.
///
/// Two independent implementations of the same rule is how a request passes on
/// the phone and fails at the Worker, and every disagreement between them shows
/// up as a 422 on the last screen of the flow with no way back to the field
/// that caused it. Where the two cannot be identical — the Worker's prose
/// checks are regular expressions — this errs toward accepting, so the Worker
/// is the only thing that ever refuses, never the other way round.
public enum ConcernValidator {
    /// The Worker's GENERIC_CONCERN, as phrases rather than a regex.
    private static let vaguePhrases = [
        "not acting like himself", "not acting like herself", "not acting like themselves",
        "not acting right", "is acting weird", "seems off", "something is wrong",
        "something's wrong", "not feeling good", "not feeling well",
        "doesn't seem normal", "does not seem normal", "i don't know", "sick", "unwell"
    ]

    /// The Worker's OBSERVABLE_DETAIL, as word stems. Matched against the start
    /// of a word, which is what `\b(stem)\w*` means.
    private static let observableStems = [
        "vomit", "diarrh", "stool", "feces", "cough", "wheez", "breath", "pant",
        "limp", "walk", "stand", "pain", "cry", "yelp", "bleed", "wound",
        "swollen", "lump", "seiz", "collaps", "unconscious", "urine", "urinat",
        "pee", "drink", "water", "eat", "food", "appetite", "eye", "ear", "skin",
        "rash", "itch", "scratch", "toxin", "poison", "chocol", "medication",
        "fever", "temperature", "discharge", "shak", "trembl", "letharg",
        "energy", "sleep", "hiding", "aggress", "abdomen", "belly", "leg",
        "paw", "mouth"
    ]

    /// The Worker's DETAIL_MODIFIER: a countable, a time, or a refusal is a
    /// concrete observation even when no body part is named.
    private static let modifierWords = [
        "once", "twice", "three", "four", "several", "every", "hourly",
        "constantly", "repeatedly", "since", "minute", "minutes", "hour",
        "hours", "day", "days", "today", "yesterday", "morning", "tonight",
        "wont", "will", "cant", "cannot", "unable", "refus", "refused",
        "refuses", "stopped", "difficulty", "struggl", "struggling"
    ]

    /// Symptoms that describe a change in manner rather than a visible sign.
    /// The Worker refuses these on their own without a concrete observation.
    private static let vagueSymptoms = ["energy_or_behavior", "other_observable"]

    public static func evaluate(summary: String, symptoms: [String], startedWhen: String) -> ConcernValidation {
        let trimmed = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmed.lowercased()
        let words = normalized.split { !$0.isLetter && !$0.isNumber }.map(String.init)
        var issues: [String] = []
        var score = min(words.count * 5, 35)

        if symptoms.isEmpty {
            issues.append("Choose at least one observable symptom.")
        } else {
            score += 20
        }

        // The Worker compares against its own list, so this compares against
        // the same one. "Non-empty" was the old rule, and it accepted every
        // string the Worker rejects.
        if ConcernOnset(rawValue: startedWhen.trimmingCharacters(in: .whitespacesAndNewlines)) == nil {
            issues.append("Choose when the concern started.")
        } else {
            score += 20
        }

        // Both halves, in the Worker's wording. The old rule asked for eight
        // words and never counted characters, so "he ate my dog toy again now"
        // passed here at 27 characters and failed there at 30.
        if trimmed.count < 30 || words.count < 6 {
            issues.append("Describe what changed with at least 30 characters and six words.")
        }

        let hasObservable = words.contains { word in observableStems.contains { word.hasPrefix($0) } }
            || normalized.contains("throw up") || normalized.contains("throwing up")
        let hasModifier = words.contains { word in
            modifierWords.contains(word) || word.allSatisfy { $0.isNumber }
        }
        let isGeneric = vaguePhrases.contains { normalized == $0 || normalized.hasSuffix($0) }

        if isGeneric || (!hasObservable && !hasModifier) {
            issues.append("Describe an observable change, not only that your pet seems off.")
        } else if hasObservable {
            score += 25
        } else {
            // A countable with no named observation is thin, but the Worker
            // accepts it, so this must too — just not at full marks.
            score += 15
        }

        if !symptoms.isEmpty, symptoms.allSatisfy({ vagueSymptoms.contains($0) }), !hasObservable {
            issues.append("Behavior or energy concerns need a specific observable action.")
        }

        return ConcernValidation(score: min(score, 100), issues: Array(Set(issues)))
    }
}
