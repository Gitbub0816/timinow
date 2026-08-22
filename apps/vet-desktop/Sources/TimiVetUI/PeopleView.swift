import Foundation
import TimiVetCore
#if os(Android)
import SkipFuseUI
#else
import SwiftUI
#endif

// SwiftUI port of the tenant people console. Windows: PeopleWindow +
// PeopleViewModel(_api, _viewModel.IsAdmin). Reads/writes
// `/api/tenant/members` (docs/PLATFORM-CONTRACT.md) — admin-only mutations,
// read-only roster for members. Creating a new Tími workspace is a platform
// operation and deliberately unreachable from here (and from the Worker
// this app talks to — see the contract's authorization model).
public struct PeopleView: View {
    let api: ClinicAPIClient
    let isAdmin: Bool

    @State var roster: TenantRoster?
    @State var isLoading = false
    @State var errorMessage: String?
    @State var newEmail = ""
    @State var newRole = "org:member"

    public init(api: ClinicAPIClient, isAdmin: Bool) {
        self.api = api
        self.isAdmin = isAdmin
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            if let errorMessage {
                Text(errorMessage).font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.danger)
            }
            if isAdmin { addMemberForm }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    membersSection
                    invitationsSection
                }
            }
            footnote
        }
        .padding(24)
        .background(TimiVetColor.canvas)
        .task { await load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("WORKSPACE PEOPLE").timiVetEyebrow()
            Text("Manage people").font(TimiVetFont.display(27))
            if !isAdmin {
                Text("You have read-only access. Ask a workspace administrator to make changes.")
                    .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            }
        }
    }

    private var addMemberForm: some View {
        HStack(spacing: 10) {
            TextField("Work email", text: $newEmail).textFieldStyle(.roundedBorder).autocorrectionDisabled()
            Picker("", selection: $newRole) {
                Text("Member").tag("org:member")
                Text("Administrator").tag("org:admin")
            }.labelsHidden().frame(width: 150)
            Button("Add") { Task { await addMember() } }
                .buttonStyle(TimiVetPrimaryButtonStyle())
                .disabled(isLoading || newEmail.trimmingCharacters(in: .whitespaces).isEmpty)
                .frame(width: 90)
        }
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("MEMBERS").timiVetEyebrow()
            ForEach(roster?.members ?? []) { member in memberRow(member) }
        }
    }

    private func memberRow(_ member: TenantMember) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name).font(TimiVetFont.ui(14, weight: .semibold))
                Text(member.email ?? "").font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
            }
            Spacer()
            if isAdmin && !member.isSelf {
                Picker("", selection: Binding(
                    get: { member.role },
                    set: { newValue in Task { await changeRole(member, to: newValue) } }
                )) {
                    Text("Member").tag("org:member")
                    Text("Administrator").tag("org:admin")
                }.labelsHidden().frame(width: 150)
                Button("Remove") { Task { await remove(member) } }.buttonStyle(TimiVetQuietButtonStyle()).frame(width: 90)
            } else {
                Text(member.role.replacingOccurrences(of: "org:", with: "").capitalized)
                    .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
                    .frame(width: 240, alignment: .trailing)
            }
        }
        .padding(.vertical, 8)
        .overlay(Divider(), alignment: .bottom)
    }

    @ViewBuilder private var invitationsSection: some View {
        if let invitations = roster?.invitations, !invitations.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("PENDING INVITATIONS").timiVetEyebrow()
                ForEach(invitations) { invitation in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(invitation.email).font(TimiVetFont.ui(13, weight: .semibold))
                            Text(invitation.role.replacingOccurrences(of: "org:", with: "").capitalized)
                                .font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                        }
                        Spacer()
                        if isAdmin {
                            Button("Revoke") { Task { await revoke(invitation) } }.buttonStyle(TimiVetQuietButtonStyle()).frame(width: 90)
                        }
                    }
                    .padding(.vertical, 8)
                    .overlay(Divider(), alignment: .bottom)
                }
            }
        }
    }

    private var footnote: some View {
        Text("Creating a new Tími workspace is a platform operation performed from the admin console — it is not available here.")
            .font(TimiVetFont.ui(10)).foregroundStyle(TimiVetColor.muted)
    }

    private func load() async {
        isLoading = true; errorMessage = nil
        defer { isLoading = false }
        do { roster = try await api.getMembers() }
        catch let error as ClinicAPIError { errorMessage = error.message }
        catch { errorMessage = error.localizedDescription }
    }

    private func addMember() async {
        isLoading = true; errorMessage = nil
        defer { isLoading = false }
        do {
            try await api.addMember(email: newEmail.trimmingCharacters(in: .whitespaces), role: newRole)
            newEmail = ""
            await load()
        } catch let error as ClinicAPIError { errorMessage = error.message }
        catch { errorMessage = error.localizedDescription }
    }

    private func changeRole(_ member: TenantMember, to role: String) async {
        errorMessage = nil
        do { try await api.changeMemberRole(clerkUserId: member.clerkUserId, role: role); await load() }
        catch let error as ClinicAPIError { errorMessage = error.message }
        catch { errorMessage = error.localizedDescription }
    }

    private func remove(_ member: TenantMember) async {
        errorMessage = nil
        do { try await api.removeMember(clerkUserId: member.clerkUserId); await load() }
        catch let error as ClinicAPIError { errorMessage = error.message }
        catch { errorMessage = error.localizedDescription }
    }

    private func revoke(_ invitation: TenantInvitation) async {
        errorMessage = nil
        do { try await api.revokeInvitation(id: invitation.id); await load() }
        catch let error as ClinicAPIError { errorMessage = error.message }
        catch { errorMessage = error.localizedDescription }
    }
}
