import Foundation
import TimiVetCore
import SwiftUI

// Fully custom Clerk sign-in screens — identifier, strategy picker, one-time
// code, then a workspace picker when the account belongs to several Clerk
// organizations. Every screen here is Tími-designed, which satisfies
// docs/PLATFORM-CONTRACT.md's "no mounted Clerk component" rule. Email and
// phone one-time codes are the only sign-in methods offered — no password,
// no Google/Apple OAuth, no passkeys — matching the owner's rule for every
// Tími sign-in surface.
public struct AuthView: View {
    @Bindable var auth: AuthController

    public init(auth: AuthController) {
        self.auth = auth
    }

    public var body: some View {
        ZStack {
            TimiVetColor.canvas.ignoresSafeArea()
            VStack(spacing: 24) {
                header
                card
            }
            .frame(maxWidth: 420)
            .padding(32)
        }
    }

    private var header: some View {
        VStack(spacing: 6) {
            Text("Tími Vet").font(TimiVetFont.display(34)).foregroundStyle(TimiVetColor.ink)
            Text("Veterinary operations console").font(TimiVetFont.ui(13)).foregroundStyle(TimiVetColor.muted)
        }
    }

    @ViewBuilder private var card: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let error = auth.errorMessage {
                Text(error).font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.danger)
            }
            switch auth.stage {
            case .identifier: identifierStage
            case .strategyPicker: strategyStage
            case .code: codeStage
            case .workspacePicker: workspaceStage
            case .signedIn: EmptyView()
            }
        }
        .timiVetCard()
        .frame(maxWidth: .infinity)
    }

    private var identifierStage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Sign in").font(TimiVetFont.ui(20, weight: .semibold))
            Text("We'll email or text you a one-time code.")
                .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            TextField("Work email or phone", text: $auth.identifierText)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
            Button("Continue") { Task { await auth.submitIdentifier() } }
                .buttonStyle(TimiVetPrimaryButtonStyle())
                .disabled(auth.isBusy)
            if auth.isBusy { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    private var strategyStage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Where should the code go?").font(TimiVetFont.ui(20, weight: .semibold))
            ForEach(auth.factorOptions) { factor in
                Button(factor.label) { Task { await auth.choose(factor) } }.buttonStyle(TimiVetQuietButtonStyle())
            }
            Button("Back") { auth.stage = .identifier }.buttonStyle(.plain).font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
        }
    }

    private var codeStage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Enter the code we sent you").font(TimiVetFont.ui(20, weight: .semibold))
            TextField("Verification code", text: $auth.codeText).textFieldStyle(.roundedBorder)
            Button("Verify") { Task { await auth.submitCode() } }.buttonStyle(TimiVetPrimaryButtonStyle()).disabled(auth.isBusy)
            backToStrategy
            if auth.isBusy { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    private var workspaceStage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Choose a workspace").font(TimiVetFont.ui(20, weight: .semibold))
            Text("This account belongs to more than one Tími workspace.").font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            ForEach(auth.workspaces) { workspace in
                Button(workspace.name) { Task { await auth.selectWorkspace(workspace) } }.buttonStyle(TimiVetQuietButtonStyle())
            }
            if auth.isBusy { ProgressView().frame(maxWidth: .infinity) }
        }
    }

    private var backToStrategy: some View {
        Button("Use a different method") {
            auth.stage = auth.factorOptions.count > 1 ? .strategyPicker : .identifier
        }
        .buttonStyle(.plain)
        .font(TimiVetFont.ui(12))
        .foregroundStyle(TimiVetColor.muted)
    }
}
