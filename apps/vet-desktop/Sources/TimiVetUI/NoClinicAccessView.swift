import Foundation
import SwiftUI

/// Shown when `GET /api/session` comes back authenticated but with
/// `surfaces.clinic == false` — a real Clerk account with no membership in
/// any Tími veterinary tenant. Lives here (not in TimiVetApp) because it
/// reads `TimiVetColor`/`TimiVetFont`/button styles, which are internal to
/// this module and not visible across the module boundary.
public struct NoClinicAccessView: View {
    var onSignOut: () -> Void
    public init(onSignOut: @escaping () -> Void) { self.onSignOut = onSignOut }

    public var body: some View {
        VStack(spacing: 16) {
            Text("No veterinary workspace access").font(TimiVetFont.display(24))
            Text("This Clerk account is not a member of a Tími veterinary tenant. Ask a workspace administrator to add you, or sign in with a different account.")
                .font(TimiVetFont.ui(13)).foregroundStyle(TimiVetColor.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            Button("Sign out", action: onSignOut).buttonStyle(TimiVetQuietButtonStyle()).frame(width: 160)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TimiVetColor.canvas)
    }
}
