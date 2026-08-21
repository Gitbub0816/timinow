import Foundation

public struct ConcernValidation: Equatable, Sendable {
    public var score: Int
    public var issues: [String]
    public var isReady: Bool { issues.isEmpty && score >= 70 }
}

public enum ConcernValidator {
    private static let vaguePhrases = [
        "not acting like himself", "not acting like herself", "not acting right",
        "is acting weird", "seems off", "something is wrong", "not feeling good",
        "doesn't seem normal", "does not seem normal", "i don't know"
    ]

    private static let observableTerms = [
        "vomit", "diarr", "cough", "breath", "limp", "bleed", "blood", "swollen",
        "pain", "cry", "yelp", "eat", "drink", "urine", "urinating", "stool",
        "letharg", "sleep", "shake", "tremor", "seiz", "wound", "eye", "ear",
        "skin", "itch", "collapse", "walk", "stand", "weight", "temperature"
    ]

    public static func evaluate(summary: String, symptoms: [String], startedWhen: String) -> ConcernValidation {
        let normalized = summary.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        let words = normalized.split { !$0.isLetter && !$0.isNumber }
        var issues: [String] = []
        var score = min(words.count * 5, 35)

        if words.count < 8 { issues.append("Add at least eight words describing what you can see, hear, or measure.") }
        if vaguePhrases.contains(where: { normalized == $0 || normalized.hasSuffix($0) }) {
            issues.append("Describe the specific change instead of only saying your pet seems off.")
        }
        if symptoms.isEmpty { issues.append("Choose at least one observable symptom.") } else { score += 20 }
        if startedWhen.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            issues.append("Tell us when the change began.")
        } else { score += 20 }
        if observableTerms.contains(where: normalized.contains) { score += 25 }
        else { issues.append("Include a concrete observation such as eating, breathing, walking, vomiting, bleeding, or bathroom changes.") }

        return ConcernValidation(score: min(score, 100), issues: Array(Set(issues)))
    }
}
