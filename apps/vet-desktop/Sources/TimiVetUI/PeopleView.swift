import Foundation
import TimiVetCore
import SwiftUI

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
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // The invite row and the roster/invitations table both
                    // read as one "people" card in the mockup — an
                    // always-visible add row above a table, not a form that
                    // appears only for admins. A non-admin still sees the
                    // row; every field and the Add button in it are disabled,
                    // matching "read-only, not hidden" for the rest of this
                    // gate.
                    addMemberForm
                    membersSection
                    invitationsSection
                }
                .timiVetCard()
            }
            footnote
        }
        .padding(24)
        .background(TimiVetColor.canvas)
        .task { await load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("WORKSPACE ACCESS").timiVetEyebrow()
            Text("Manage people").font(TimiVetFont.display(27))
            if !isAdmin {
                Text("You have read-only access. Ask a workspace administrator to make changes.")
                    .font(TimiVetFont.ui(12)).foregroundStyle(TimiVetColor.muted)
            }
        }
    }

    /// The mockup's `.invite-row` — a blue-tinted strip above the table. Kept
    /// visible for a non-admin (rather than hidden, per the task's "read-only,
    /// not hidden" rule for a gated section) with every control disabled.
    private var addMemberForm: some View {
        HStack(spacing: 10) {
            TextField("Work email", text: $newEmail).textFieldStyle(.roundedBorder).autocorrectionDisabled()
                .disabled(!isAdmin)
            Picker("", selection: $newRole) {
                Text("Member").tag("org:member")
                Text("Administrator").tag("org:admin")
            }.labelsHidden().frame(width: 150).disabled(!isAdmin)
            Button("Add person") { Task { await addMember() } }
                .buttonStyle(TimiVetPrimaryButtonStyle())
                .disabled(!isAdmin || isLoading || newEmail.trimmingCharacters(in: .whitespaces).isEmpty)
                .frame(width: 120)
        }
        .padding(14)
        .background(TimiVetColor.blueSoft, in: RoundedRectangle(cornerRadius: 12))
    }

    private func initials(_ name: String) -> String {
        let parts = name.split(separator: " ")
        let letters = parts.prefix(2).compactMap { $0.first }
        return letters.isEmpty ? "?" : String(letters).uppercased()
    }

    private func avatar(_ text: String) -> some View {
        Text(text)
            .font(TimiVetFont.ui(12, weight: .bold)).foregroundStyle(TimiVetColor.navy)
            .frame(width: 38, height: 38)
            .background(TimiVetColor.publicCapacityBackground, in: RoundedRectangle(cornerRadius: 11))
            .overlay(RoundedRectangle(cornerRadius: 11).stroke(TimiVetColor.sectionBorder, lineWidth: 1))
    }

    private func statusPill(_ text: String, color: Color = TimiVetColor.green) -> some View {
        Text(text).font(TimiVetFont.ui(11, weight: .bold)).foregroundStyle(color)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(color.opacity(0.14), in: Capsule())
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("MEMBERS").timiVetEyebrow()
            ForEach(roster?.members ?? []) { member in memberRow(member) }
        }
    }

    private func memberRow(_ member: TenantMember) -> some View {
        HStack(spacing: 12) {
            avatar(initials(member.name))
            VStack(alignment: .leading, spacing: 2) {
                Text(member.name).font(TimiVetFont.ui(14, weight: .semibold))
                Text(member.email ?? "").font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
            }
            Spacer()
            statusPill("Active")
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
                    .frame(width: 150, alignment: .trailing)
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
                    HStack(spacing: 12) {
                        avatar(initials(invitation.email))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(invitation.email).font(TimiVetFont.ui(13, weight: .semibold))
                            Text(invitation.role.replacingOccurrences(of: "org:", with: "").capitalized)
                                .font(TimiVetFont.ui(11)).foregroundStyle(TimiVetColor.muted)
                        }
                        Spacer()
                        statusPill("Invited", color: TimiVetColor.gold)
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
