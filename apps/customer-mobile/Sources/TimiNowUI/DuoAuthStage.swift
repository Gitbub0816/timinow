import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

/// Signing in, on the fold, driven by the wheel.
///
/// The phone app puts onboarding before sign-in: a stranger is asked their
/// pet's name rather than their email. That ordering earns its keep on a
/// phone, where the alternative is a login wall as the first thing anybody
/// sees. It does not transfer here, because the fold app *already* asks for
/// the pet, the species and the urgency on the wheel — running a separate
/// four-step onboarding first would ask the same questions twice, in two
/// different interaction models, before showing the one this app is for.
///
/// So the fold app signs you in and then puts you on the wheel. Pets are added
/// from the Pets section, with the same control as everything else.
///
/// Typing is still typing: an address and a six-digit code need a keyboard,
/// and no amount of wheel makes that untrue. The wheel carries the *choices* —
/// send the code, start over — which is all it ever claimed to do.
struct DuoAuthStage: View {
    @Bindable var auth: AuthController

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer(minLength: 0)
            switch auth.stage {
            case .identifier: identifierStage
            case .code:       codeStage
            default:          fallbackStage
            }
            Spacer(minLength: 0)
            notice
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    // MARK: Stages

    private var identifierStage: some View {
        VStack(alignment: .leading, spacing: 18) {
            heading("Let\u{2019}s get you signed in.",
                    "An address or a mobile number. We send a code \u{2014} there is no password to invent, and no separate sign-up.")
            field(text: $auth.identifierText,
                  placeholder: "you@example.com or 415 555 0100",
                  label: "Email or mobile number")
            problem
        }
    }

    private var codeStage: some View {
        VStack(alignment: .leading, spacing: 18) {
            heading("Enter the code.",
                    "Six digits, just sent to \(auth.identifierText).")
            field(text: $auth.codeText, placeholder: "123456", label: "Code", numeric: true)
            problem
        }
    }

    /// The account-creation and factor-picking stages are several fields each
    /// and comparatively rare. They keep the phone screen rather than being
    /// half-rebuilt here — a form that works is better than a fold-native one
    /// that does not.
    private var fallbackStage: some View {
        SignInView(auth: auth, handoff: false, handoffPetName: "")
            .frame(maxWidth: 640)
    }

    // MARK: Pieces

    private func heading(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 46, weight: .black, design: .serif))
                .minimumScaleFactor(0.5)
                .lineLimit(2)
            Text(detail)
                .font(.system(size: 17))
                .foregroundStyle(TimiColor.muted)
                .lineLimit(3)
        }
    }

    private func field(text: Binding<String>, placeholder: String,
                       label: String, numeric: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label.uppercased())
                .font(.system(size: 11, weight: .black)).tracking(1.3)
                .foregroundStyle(TimiColor.muted)
            TextField(placeholder, text: text)
                .font(.system(size: 26, weight: .bold))
                .textContentType(numeric ? .oneTimeCode : .username)
                .timiKeyboard(numeric ? .number : .email)
                .autocorrectionDisabled()
                .timiNoAutocapitalization()
                .padding(.horizontal, 20).padding(.vertical, 16)
                .frame(maxWidth: 560)
                .timiCard(Color.white)
        }
    }

    @ViewBuilder private var problem: some View {
        if let message = auth.errorMessage {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(TimiColor.coral)
                    .accessibilityHidden(true)
                Text(message).font(.system(size: 15, weight: .semibold))
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: 560, alignment: .leading)
            .background(TimiColor.coralSoft, in: RoundedRectangle(cornerRadius: 14))
        }
    }

    private var notice: some View {
        Text("Tími asks clinics about live capacity. It does not diagnose, provide veterinary advice, or guarantee an appointment.")
            .font(.system(size: 12))
            .foregroundStyle(TimiColor.muted)
    }
}
