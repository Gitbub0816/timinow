import Foundation
import TimiNowCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

/// Sign-in, in Tími's own screens.
///
/// Every screen here is ours — docs/PLATFORM-CONTRACT.md's authentication rule
/// forbids mounting a Clerk-hosted component, and a pet owner in a hurry
/// should not be handed a different-looking website either.
///
/// One field to start. If Clerk knows the address you sign in; if it does not,
/// one more screen collects the name, email and mobile number that every care
/// request needs anyway, and the same code screen finishes the job. Nobody is
/// told "we couldn't find your account" and left there, and nobody types their
/// own phone number twice.
struct SignInView: View {
    @Bindable var auth: AuthController

    var body: some View {
        ZStack {
            TimiColor.canvas.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Spacer(minLength: 40)
                    TimiWordmark()
                    Text(headline)
                        .font(.system(size: 38, weight: .bold, design: .serif))
                        .foregroundStyle(TimiColor.ink)
                    Text(subhead)
                        .font(.title3)
                        .foregroundStyle(TimiColor.muted)

                    if let error = auth.errorMessage {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .foregroundStyle(TimiColor.coral)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(TimiColor.coralSoft, in: RoundedRectangle(cornerRadius: 14))
                    }

                    stageContent

                    if auth.stage != .identifier {
                        Button("Start over") { auth.startOver() }
                            .buttonStyle(TimiQuietButtonStyle())
                    }

                    Text("Tími asks clinics about live capacity. It does not diagnose, provide veterinary advice, or guarantee an appointment.")
                        .font(.caption)
                        .foregroundStyle(TimiColor.muted)
                    Spacer(minLength: 24)
                }
                .padding(24)
            }
        }
    }

    private var headline: String {
        switch auth.stage {
        case .identifier: return "Who should we\nkeep this for?"
        case .profile: return "Let's set up\nyour account"
        case .strategyPicker: return "How would you\nlike to sign in?"
        case .password: return "Enter your\npassword"
        case .code: return auth.isCreatingAccount ? "Check your\nmessages" : "Enter the code\nwe sent"
        case .signedIn: return "You're in"
        }
    }

    private var subhead: String {
        switch auth.stage {
        case .identifier:
            return "Your pets, your details, and every request stay with your account — so you never type them twice."
        case .profile:
            return "Clinics need a name and a number to expect you by. Tími asks once, then fills it in for every request."
        case .strategyPicker:
            return "Choose whichever is quickest right now."
        case .password:
            return "Signing in as \(auth.pendingIdentifier)."
        case .code:
            // Sign-up verifies whatever Clerk still has unverified, which is
            // not always the address that was typed first — naming the wrong
            // one sends people to the wrong inbox.
            let destination = auth.verifyingField.isEmpty ? auth.pendingIdentifier : auth.verifyingField
            return auth.isCreatingAccount
                ? "We sent a code to \(destination) to finish setting up your account."
                : "We sent a code to \(destination)."
        case .signedIn:
            return ""
        }
    }

    @ViewBuilder private var stageContent: some View {
        switch auth.stage {
        case .identifier:
            VStack(alignment: .leading, spacing: 12) {
                TextField("Email or mobile number", text: $auth.identifierText)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(14)
                    .background(.white, in: RoundedRectangle(cornerRadius: 15))
                    .overlay(RoundedRectangle(cornerRadius: 15).stroke(TimiColor.ink.faded(0.18)))
                Button { Task { await auth.submitIdentifier() } } label: {
                    Label("Continue", systemImage: "arrow.right")
                }
                .buttonStyle(TimiPrimaryButtonStyle())
                .disabled(auth.isBusy)
                Text("New here? Entering your email or number starts a new account — there's no separate sign-up.")
                    .font(.caption).foregroundStyle(TimiColor.muted)
            }

        case .profile:
            VStack(alignment: .leading, spacing: 12) {
                TextField("Your full name", text: $auth.signUpName)
                    .textContentType(.name)
                    .padding(14)
                    .background(.white, in: RoundedRectangle(cornerRadius: 15))
                    .overlay(RoundedRectangle(cornerRadius: 15).stroke(TimiColor.ink.faded(0.18)))
                TextField("Email address", text: $auth.signUpEmail)
                    .textContentType(.emailAddress)
                    .keyboardType(.emailAddress)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(14)
                    .background(.white, in: RoundedRectangle(cornerRadius: 15))
                    .overlay(RoundedRectangle(cornerRadius: 15).stroke(TimiColor.ink.faded(0.18)))
                TextField("Mobile number", text: $auth.signUpPhone)
                    .textContentType(.telephoneNumber)
                    .keyboardType(.phonePad)
                    .padding(14)
                    .background(.white, in: RoundedRectangle(cornerRadius: 15))
                    .overlay(RoundedRectangle(cornerRadius: 15).stroke(TimiColor.ink.faded(0.18)))
                Button { Task { await auth.submitProfile() } } label: {
                    Label("Create my account", systemImage: "arrow.right")
                }
                .buttonStyle(TimiPrimaryButtonStyle())
                .disabled(auth.isBusy)
                Text("We text the clinic's confirmation to your mobile, and keep the rest with your account.")
                    .font(.caption).foregroundStyle(TimiColor.muted)
            }

        case .strategyPicker:
            VStack(alignment: .leading, spacing: 10) {
                ForEach(auth.factorOptions) { option in
                    Button(option.label) { Task { await auth.choose(option) } }
                        .buttonStyle(TimiQuietButtonStyle())
                        .disabled(auth.isBusy)
                }
            }

        case .password:
            VStack(alignment: .leading, spacing: 12) {
                SecureField("Password", text: $auth.passwordText)
                    .textContentType(.password)
                    .padding(14)
                    .background(.white, in: RoundedRectangle(cornerRadius: 15))
                    .overlay(RoundedRectangle(cornerRadius: 15).stroke(TimiColor.ink.faded(0.18)))
                Button { Task { await auth.submitPassword() } } label: {
                    Label("Sign in", systemImage: "arrow.right")
                }
                .buttonStyle(TimiPrimaryButtonStyle())
                .disabled(auth.isBusy)
            }

        case .code:
            VStack(alignment: .leading, spacing: 12) {
                TextField("6-digit code", text: $auth.codeText)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .padding(14)
                    .background(.white, in: RoundedRectangle(cornerRadius: 15))
                    .overlay(RoundedRectangle(cornerRadius: 15).stroke(TimiColor.ink.faded(0.18)))
                Button { Task { await auth.submitCode() } } label: {
                    Label(auth.isCreatingAccount ? "Create my account" : "Sign in", systemImage: "arrow.right")
                }
                .buttonStyle(TimiPrimaryButtonStyle())
                .disabled(auth.isBusy)
            }

        case .signedIn:
            EmptyView()
        }
    }
}
