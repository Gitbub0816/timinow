using System.Collections.ObjectModel;
using System.Threading;
using TimiVet.Models;
using TimiVet.Services;

namespace TimiVet.ViewModels;

/// <summary>Backs PeopleWindow — the tenant console for /api/tenant/members. Creating a new workspace is
/// deliberately out of scope here; that is a Tími platform operation performed only from the admin console.</summary>
public sealed class PeopleViewModel : ObservableObject
{
    private readonly ClinicApiClient _api;
    private readonly CancellationTokenSource _lifetime = new();
    private bool _isBusy;
    private string _statusMessage = "";
    private string _newMemberEmail = "";
    private string _newMemberRole = "org:member";

    public PeopleViewModel(ClinicApiClient api, bool isAdmin)
    {
        _api = api;
        IsAdmin = isAdmin;
        LoadCommand = new AsyncCommand(LoadAsync, () => !IsBusy);
        AddMemberCommand = new AsyncCommand(AddMemberAsync, () => IsAdmin && !IsBusy && !string.IsNullOrWhiteSpace(NewMemberEmail));
        ChangeRoleCommand = new AsyncCommand<TenantMember>(ChangeRoleAsync, m => IsAdmin && !IsBusy && m is not null);
        RemoveMemberCommand = new AsyncCommand<TenantMember>(RemoveMemberAsync, m => IsAdmin && !IsBusy && m is not null);
        RevokeInvitationCommand = new AsyncCommand<TenantInvitation>(RevokeInvitationAsync, i => IsAdmin && !IsBusy && i is not null);
    }

    public bool IsAdmin { get; }
    public bool IsBusy { get => _isBusy; private set { if (Set(ref _isBusy, value)) RaiseCommands(); } }
    public string StatusMessage { get => _statusMessage; private set => Set(ref _statusMessage, value); }
    public string NewMemberEmail { get => _newMemberEmail; set => Set(ref _newMemberEmail, value); }
    public string NewMemberRole { get => _newMemberRole; set => Set(ref _newMemberRole, value); }
    public IReadOnlyList<string> RoleOptions { get; } = ["org:member", "org:admin"];

    public ObservableCollection<TenantMember> Members { get; } = [];
    public ObservableCollection<TenantInvitation> Invitations { get; } = [];

    public AsyncCommand LoadCommand { get; }
    public AsyncCommand AddMemberCommand { get; }
    public AsyncCommand<TenantMember> ChangeRoleCommand { get; }
    public AsyncCommand<TenantMember> RemoveMemberCommand { get; }
    public AsyncCommand<TenantInvitation> RevokeInvitationCommand { get; }

    private async Task LoadAsync()
    {
        IsBusy = true;
        try
        {
            var roster = await _api.GetTenantMembersAsync(_lifetime.Token);
            Members.Clear(); foreach (var member in roster.Members) Members.Add(member);
            Invitations.Clear(); foreach (var invitation in roster.Invitations) Invitations.Add(invitation);
            StatusMessage = $"{Members.Count} member(s) · {Invitations.Count} pending invitation(s)";
        }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task AddMemberAsync()
    {
        IsBusy = true;
        try
        {
            await _api.AddTenantMemberAsync(NewMemberEmail.Trim(), NewMemberRole, _lifetime.Token);
            NewMemberEmail = "";
            StatusMessage = "Invitation sent.";
            await LoadAsync();
        }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task ChangeRoleAsync(TenantMember member)
    {
        IsBusy = true;
        try { await _api.ChangeTenantMemberRoleAsync(member.UserId, member.Role, _lifetime.Token); StatusMessage = $"Updated {member.Email}'s role."; await LoadAsync(); }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task RemoveMemberAsync(TenantMember member)
    {
        IsBusy = true;
        try { await _api.RemoveTenantMemberAsync(member.UserId, _lifetime.Token); StatusMessage = $"Removed {member.Email} from the workspace."; await LoadAsync(); }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task RevokeInvitationAsync(TenantInvitation invitation)
    {
        IsBusy = true;
        try { await _api.RevokeInvitationAsync(invitation.Id, _lifetime.Token); StatusMessage = $"Revoked the invitation for {invitation.Email}."; await LoadAsync(); }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    private void RaiseCommands()
    {
        LoadCommand.RaiseCanExecuteChanged();
        AddMemberCommand.RaiseCanExecuteChanged();
        ChangeRoleCommand.RaiseCanExecuteChanged();
        RemoveMemberCommand.RaiseCanExecuteChanged();
        RevokeInvitationCommand.RaiseCanExecuteChanged();
    }
}
