import Foundation

/// What a person is told when something fails, and what an operator gets.
///
/// Until now these were the same string. A pet owner standing in a car park
/// was shown
///
///   Sign in is required to continue. (401 [AUTHENTICATION_REQUIRED] from
///   /api/intakes/intake_be49b8c23b0c4eaf92d4e0beac5ca377/status)
///
/// which names an internal route and a record id, tells them to do something
/// they have already done, and — because the real cause was a token that
/// expired forty seconds earlier — is not even true. It is a good line in a
/// log. It is a terrible line on a phone.
///
/// So there are two outputs now. The screen gets one sentence: what to do
/// about it if there is something, an apology and a reference code if there
/// is not. The reference goes to the Worker with everything else attached,
/// where an operator can read it and where "it said something about a
/// reference" becomes one row.
public struct PublicFailure: Sendable, Equatable {
    /// The sentence to show. Never contains a route, a status code, a record
    /// id, or the word "null".
    public var message: String
    /// Shown only when there is nothing the person can do — it is for support
    /// to quote back, and printing one on a fixable mistake is noise.
    public var reference: String?

    public var displayText: String {
        guard let reference, !reference.isEmpty else { return message }
        return "\(message) (Reference \(reference))"
    }
}

public enum ErrorPresenter {
    /// Codes a person can act on. Everything else is ours to fix, and saying
    /// so in detail helps nobody standing in a car park.
    ///
    /// Deliberately a small list. The default has to be the vague one: a code
    /// nobody has classified is far more likely to be an internal fault than a
    /// user mistake, and guessing the other way puts "database unavailable" in
    /// front of somebody as though they had mistyped something.
    private static let actionable: Set<String> = [
        "VALIDATION_FAILED", "INVALID_STATUS", "INVALID_TRANSITION", "INVALID_MILESTONE",
        "INVALID_SPECIES", "INVALID_LOCATION", "INVALID_EMAIL", "INVALID_ROLE",
        "OFFER_UNAVAILABLE", "SEARCH_EXPIRED", "OFFER_EXPIRED", "PAYMENT_DECLINED"
    ]

    /// The one message for everything we cannot ask somebody to fix.
    ///
    /// One sentence, no jargon, and it says what to do — wait a moment and try
    /// again — because "an unexpected error occurred" leaves a person with no
    /// next move at all.
    public static let vague = "That didn't work. Give it a moment and try again."

    public static func present(_ error: Error) -> PublicFailure {
        if error is CancellationError { return PublicFailure(message: "", reference: nil) }
        guard let apiError = error as? TimiAPIError else {
            return PublicFailure(message: vague, reference: reference())
        }
        switch apiError {
        case .server(let status, let code, let message, _):
            // 401 after the gateway has already retried with a freshly minted
            // token means the session really is gone. Before that retry
            // existed, this was the single most common thing anybody saw, and
            // it was wrong every time.
            if status == 401 || status == 403 {
                return PublicFailure(message: "Please sign in again to continue.", reference: nil)
            }
            if status == 404 {
                return PublicFailure(message: "That's no longer available. Start again from the home screen.", reference: nil)
            }
            if let code, actionable.contains(code) {
                // The Worker's own wording, which for these is written for the
                // person: "Choose when the concern started", not a stack.
                return PublicFailure(message: message, reference: nil)
            }
            if status == 429 {
                return PublicFailure(message: "Tími is busy right now. Try again in a moment.", reference: nil)
            }
            return PublicFailure(message: vague, reference: reference())
        case .transport:
            // Distinguishable and fixable by the person: it is the one failure
            // where "check your connection" is real advice rather than a
            // deflection.
            return PublicFailure(message: "Tími can't reach the network right now. Check your connection and try again.", reference: nil)
        case .invalidConfiguration, .invalidResponse:
            return PublicFailure(message: vague, reference: reference())
        }
    }

    /// A Clerk failure, worded for the person.
    ///
    /// Clerk's own `long_message` is written for a customer — "Incorrect code",
    /// "That phone number is taken" — so it is kept. What is dropped is the
    /// "(422 [form_code_incorrect] from /v1/client/sign_ins/…)" tail that
    /// `TimiAPIError.message` appends, which is the part that made every
    /// sign-in error look like a stack trace.
    public static func signIn(_ error: Error) -> PublicFailure {
        guard let apiError = error as? TimiAPIError else {
            return PublicFailure(message: vague, reference: reference())
        }
        if case .server(let status, _, let message, _) = apiError {
            // Clerk explains a 4xx in words worth showing. A 5xx is ours.
            if status >= 400 && status < 500 && !message.isEmpty {
                return PublicFailure(message: message, reference: nil)
            }
            return PublicFailure(message: vague, reference: reference())
        }
        if case .transport = apiError {
            return PublicFailure(message: "Tími can't reach the sign-in service. Check your connection and try again.", reference: nil)
        }
        return PublicFailure(message: vague, reference: reference())
    }

    /// The detail an operator gets, for the report that goes with the
    /// reference. Never shown on a screen.
    public static func diagnostics(_ error: Error) -> (path: String?, status: Int?, code: String?, message: String) {
        guard let apiError = error as? TimiAPIError else {
            return (nil, nil, nil, String(describing: error))
        }
        switch apiError {
        case .server(let status, let code, let message, let path):
            return (path, status, code, message)
        case .transport(let reason, let path):
            return (path, nil, "TRANSPORT", reason)
        case .invalidConfiguration(let address):
            return (nil, nil, "INVALID_CONFIGURATION", address)
        case .invalidResponse(let path):
            return (path, nil, "INVALID_RESPONSE", "The response could not be decoded.")
        }
    }

    /// Six characters, no vowels so it cannot spell anything, and none of the
    /// pairs that are misheard over a phone.
    static func reference() -> String {
        let alphabet = Array("23456789BCDFGHJKLMNPQRSTVWXZ")
        var out = ""
        for _ in 0..<6 { out.append(alphabet[Int.random(in: 0..<alphabet.count)]) }
        return out
    }
}
