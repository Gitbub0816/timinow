using System.Collections.ObjectModel;
using System.Threading;
using System.Windows.Threading;
using TimiVet.Models;
using TimiVet.Services;

namespace TimiVet.ViewModels;

public enum SignInStep
{
    WorkerUrl,
    Identifier,
    Strategy,
    Password,
    Code,
    Workspace,
    NotClinicWorkspace
}

/// <summary>
/// Drives the Tími-designed sign-in window through Clerk's Frontend API (see ClerkAuthService).
/// No Clerk-hosted or Clerk-branded UI is ever mounted — every step here is a plain WPF screen.
/// </summary>
public sealed class SignInViewModel : ObservableObject
{
    private readonly ClerkAuthService _auth;
    private readonly ClinicApiClient _api;
    private readonly SettingsStore _settingsStore;
    private readonly DispatcherTimer _resendTimer;

    private SignInStep _step = SignInStep.WorkerUrl;
    private bool _isBusy;
    private string _errorText = "";
    private string _identifier = "";
    private string _password = "";
    private string _code = "";
    private int _resendSecondsRemaining;
    private bool _awaitingNewPassword;
    private bool _isPasswordReset;
    private string? _signInId;
    private ClerkFirstFactor? _chosenFactor;
    private ClerkOrganizationMembershipResource? _selectedWorkspace;
    private SessionDescriptor? _session;

    public SignInViewModel(AppSettings settings, ClerkAuthService auth, ClinicApiClient api, SettingsStore settingsStore)
    {
        Settings = settings;
        _auth = auth;
        _api = api;
        _settingsStore = settingsStore;

        ContinueWorkerUrlCommand = new AsyncCommand(ContinueWorkerUrlAsync, () => !IsBusy);
        ContinueIdentifierCommand = new AsyncCommand(ContinueIdentifierAsync, () => !IsBusy);
        GoogleCommand = new AsyncCommand(() => RunRedirectAsync("oauth_google"), () => !IsBusy);
        AppleCommand = new AsyncCommand(() => RunRedirectAsync("oauth_apple"), () => !IsBusy);
        PasskeyCommand = new AsyncCommand(() => RunRedirectAsync("passkey"), () => !IsBusy);
        ChooseStrategyCommand = new AsyncCommand<ClerkFirstFactor>(ChooseStrategyAsync, _ => !IsBusy);
        SubmitPasswordCommand = new AsyncCommand(SubmitPasswordAsync, () => !IsBusy);
        ForgotPasswordCommand = new AsyncCommand(ForgotPasswordAsync, () => !IsBusy);
        ResendCodeCommand = new AsyncCommand(ResendCodeAsync, () => !IsBusy && _resendSecondsRemaining == 0);
        ChooseWorkspaceCommand = new AsyncCommand<ClerkOrganizationMembershipResource>(ChooseWorkspaceAsync, _ => !IsBusy);
        BackToIdentifierCommand = new RelayCommand(() => { ErrorText = ""; Step = SignInStep.Identifier; });
        SwitchAccountCommand = new AsyncCommand(SwitchAccountAsync, () => !IsBusy);
        RetryWorkspaceCheckCommand = new AsyncCommand(() => CheckSessionAsync(), () => !IsBusy);

        _resendTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _resendTimer.Tick += (_, _) =>
        {
            ResendSecondsRemaining = Math.Max(0, ResendSecondsRemaining - 1);
            if (ResendSecondsRemaining == 0) _resendTimer.Stop();
            ResendCodeCommand.RaiseCanExecuteChanged();
        };
    }

    public AppSettings Settings { get; }

    /// <summary>Raised once a session with clinic surface access has been established; the window closes on this.</summary>
    public event EventHandler<SessionDescriptor>? SignedIn;

    public SignInStep Step
    {
        get => _step;
        private set
        {
            if (Set(ref _step, value))
            {
                Raise(nameof(IsWorkerUrlStep)); Raise(nameof(IsIdentifierStep)); Raise(nameof(IsStrategyStep));
                Raise(nameof(IsPasswordStep)); Raise(nameof(IsCodeStep)); Raise(nameof(IsWorkspaceStep)); Raise(nameof(IsNotClinicStep));
            }
        }
    }

    public bool IsWorkerUrlStep => Step == SignInStep.WorkerUrl;
    public bool IsIdentifierStep => Step == SignInStep.Identifier;
    public bool IsStrategyStep => Step == SignInStep.Strategy;
    public bool IsPasswordStep => Step == SignInStep.Password;
    public bool IsCodeStep => Step == SignInStep.Code;
    public bool IsWorkspaceStep => Step == SignInStep.Workspace;
    public bool IsNotClinicStep => Step == SignInStep.NotClinicWorkspace;

    public bool IsBusy { get => _isBusy; private set { if (Set(ref _isBusy, value)) RaiseCommands(); } }
    public string ErrorText { get => _errorText; private set => Set(ref _errorText, value); }
    public string Identifier { get => _identifier; set => Set(ref _identifier, value); }
    public string Password { get => _password; set => Set(ref _password, value); }
    public string Code { get => _code; set => Set(ref _code, value); }
    public int ResendSecondsRemaining { get => _resendSecondsRemaining; private set => Set(ref _resendSecondsRemaining, value); }
    public bool AwaitingNewPassword { get => _awaitingNewPassword; private set => Set(ref _awaitingNewPassword, value); }
    public string? SafeIdentifier => _chosenFactor?.SafeIdentifier ?? Identifier;
    public SessionDescriptor? Session => _session;

    public ObservableCollection<ClerkFirstFactor> StrategyOptions { get; } = [];
    public ObservableCollection<ClerkOrganizationMembershipResource> WorkspaceOptions { get; } = [];

    public AsyncCommand ContinueWorkerUrlCommand { get; }
    public AsyncCommand ContinueIdentifierCommand { get; }
    public AsyncCommand GoogleCommand { get; }
    public AsyncCommand AppleCommand { get; }
    public AsyncCommand PasskeyCommand { get; }
    public AsyncCommand<ClerkFirstFactor> ChooseStrategyCommand { get; }
    public AsyncCommand SubmitPasswordCommand { get; }
    public AsyncCommand ForgotPasswordCommand { get; }
    public AsyncCommand ResendCodeCommand { get; }
    public AsyncCommand<ClerkOrganizationMembershipResource> ChooseWorkspaceCommand { get; }
    public RelayCommand BackToIdentifierCommand { get; }
    public AsyncCommand SwitchAccountCommand { get; }
    public AsyncCommand RetryWorkspaceCheckCommand { get; }

    private async Task ContinueWorkerUrlAsync()
    {
        ErrorText = "";
        var url = Settings.ApiBaseUrl.Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && !uri.IsLoopback))
        {
            ErrorText = "Enter the full HTTPS URL of your Tími Worker (for example https://timinow-vet.example.workers.dev).";
            return;
        }
        IsBusy = true;
        try
        {
            _settingsStore.Save(Settings);
            _api.UpdateSettings(Settings);
            await _auth.ResolveFrontendApiBaseAsync(url, CancellationToken.None);
            Step = SignInStep.Identifier;
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task ContinueIdentifierAsync()
    {
        if (string.IsNullOrWhiteSpace(Identifier)) { ErrorText = "Enter your email, username, or phone number."; return; }
        ErrorText = "";
        IsBusy = true;
        try
        {
            var state = await _auth.StartSignInAsync(Identifier.Trim(), CancellationToken.None);
            _signInId = state.SignInId;
            StrategyOptions.Clear();
            foreach (var factor in state.SupportedFirstFactors) StrategyOptions.Add(factor);

            if (StrategyOptions.Count == 1)
                await ChooseStrategyAsync(StrategyOptions[0]);
            else
                Step = SignInStep.Strategy;
        }
        catch (ClerkApiException ex) { ErrorText = ex.Message; }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task RunRedirectAsync(string strategy)
    {
        ErrorText = "";
        IsBusy = true;
        try
        {
            var ok = await _auth.RunRedirectSignInAsync(strategy, CancellationToken.None);
            if (!ok) { ErrorText = "The browser sign-in did not complete. Please try again."; return; }
            await AfterSignedInAsync();
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task ChooseStrategyAsync(ClerkFirstFactor factor)
    {
        if (_signInId is null) return;
        ErrorText = "";
        _chosenFactor = factor;
        _isPasswordReset = false;

        if (factor.Strategy == "password")
        {
            AwaitingNewPassword = false;
            Step = SignInStep.Password;
            return;
        }

        IsBusy = true;
        try
        {
            await _auth.PrepareFirstFactorAsync(_signInId, factor.Strategy, factor.EmailAddressId, factor.PhoneNumberId, CancellationToken.None);
            Code = "";
            StartResendCooldown();
            Step = SignInStep.Code;
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task SubmitPasswordAsync()
    {
        if (_signInId is null) return;
        if (string.IsNullOrWhiteSpace(Password)) { ErrorText = "Enter your password."; return; }
        ErrorText = "";
        IsBusy = true;
        try
        {
            var state = _awaitingNewPassword
                ? await _auth.ResetPasswordAsync(_signInId, Password, CancellationToken.None)
                : await _auth.AttemptFirstFactorAsync(_signInId, "password", null, Password, CancellationToken.None);
            Password = "";
            await HandlePostAttemptAsync(state);
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task ForgotPasswordAsync()
    {
        if (_signInId is null) return;
        var resetFactor = StrategyOptions.FirstOrDefault(f => f.Strategy == "reset_password_email_code");
        if (resetFactor is null) { ErrorText = "Password reset by email isn't available for this account."; return; }
        ErrorText = "";
        IsBusy = true;
        try
        {
            _chosenFactor = resetFactor;
            _isPasswordReset = true;
            await _auth.PrepareFirstFactorAsync(_signInId, resetFactor.Strategy, resetFactor.EmailAddressId, resetFactor.PhoneNumberId, CancellationToken.None);
            Code = "";
            StartResendCooldown();
            Step = SignInStep.Code;
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    public async Task SubmitCodeAsync(string code)
    {
        if (_signInId is null || _chosenFactor is null) return;
        ErrorText = "";
        IsBusy = true;
        try
        {
            var state = await _auth.AttemptFirstFactorAsync(_signInId, _chosenFactor.Strategy, code, null, CancellationToken.None);
            await HandlePostAttemptAsync(state);
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task ResendCodeAsync()
    {
        if (_signInId is null || _chosenFactor is null) return;
        ErrorText = "";
        IsBusy = true;
        try
        {
            await _auth.PrepareFirstFactorAsync(_signInId, _chosenFactor.Strategy, _chosenFactor.EmailAddressId, _chosenFactor.PhoneNumberId, CancellationToken.None);
            StartResendCooldown();
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task HandlePostAttemptAsync(ClerkAuthState state)
    {
        if (state.Status == ClerkSignInStatus.NeedsNewPassword)
        {
            AwaitingNewPassword = true;
            Step = SignInStep.Password;
            return;
        }

        if (state.Status == ClerkSignInStatus.Complete && state.SessionId is not null)
        {
            await AfterSignedInAsync();
            return;
        }

        if (_isPasswordReset)
        {
            ErrorText = "That reset code did not match. Request a new one and try again.";
            return;
        }

        ErrorText = "That code did not match. Try again.";
    }

    private async Task AfterSignedInAsync()
    {
        List<ClerkOrganizationMembershipResource> memberships;
        try { memberships = await _auth.GetOrganizationMembershipsAsync(CancellationToken.None); }
        catch { memberships = []; }

        if (memberships.Count == 1)
        {
            await ActivateAndCheckAsync(memberships[0]);
            return;
        }

        if (memberships.Count > 1)
        {
            WorkspaceOptions.Clear();
            foreach (var membership in memberships) WorkspaceOptions.Add(membership);
            Step = SignInStep.Workspace;
            return;
        }

        // No organization membership at all — proceed straight to the session check, which will show
        // the "not part of a veterinary workspace" screen if the Worker agrees there is no clinic surface.
        await CheckSessionAsync();
    }

    private async Task ChooseWorkspaceAsync(ClerkOrganizationMembershipResource membership) => await ActivateAndCheckAsync(membership);

    private async Task ActivateAndCheckAsync(ClerkOrganizationMembershipResource membership)
    {
        _selectedWorkspace = membership;
        IsBusy = true;
        try
        {
            if (membership.Organization is not null) await _auth.ActivateOrganizationAsync(membership.Organization.Id, CancellationToken.None);
            await CheckSessionAsync();
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    /// <summary>
    /// Entry point used when a Clerk session was already restored from disk (no Worker URL / identifier /
    /// password step needed) but the last check found no clinic surface — jumps straight to that outcome.
    /// </summary>
    public Task EnterAtSessionCheckAsync() => CheckSessionAsync();

    private async Task CheckSessionAsync()
    {
        ErrorText = "";
        IsBusy = true;
        try
        {
            _session = await _api.GetSessionAsync(CancellationToken.None);
            if (_session.Surfaces.Clinic) SignedIn?.Invoke(this, _session);
            else Step = SignInStep.NotClinicWorkspace;
        }
        catch (Exception ex) { ErrorText = ex.Message; Step = SignInStep.NotClinicWorkspace; }
        finally { IsBusy = false; }
    }

    private async Task SwitchAccountAsync()
    {
        IsBusy = true;
        try
        {
            await _auth.SignOutAsync(CancellationToken.None);
            Identifier = ""; Password = ""; Code = ""; _signInId = null; _chosenFactor = null; _selectedWorkspace = null;
            StrategyOptions.Clear(); WorkspaceOptions.Clear();
            Step = SignInStep.Identifier;
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private void StartResendCooldown()
    {
        ResendSecondsRemaining = 30;
        ResendCodeCommand.RaiseCanExecuteChanged();
        _resendTimer.Stop();
        _resendTimer.Start();
    }

    private void RaiseCommands()
    {
        ContinueWorkerUrlCommand.RaiseCanExecuteChanged();
        ContinueIdentifierCommand.RaiseCanExecuteChanged();
        GoogleCommand.RaiseCanExecuteChanged();
        AppleCommand.RaiseCanExecuteChanged();
        PasskeyCommand.RaiseCanExecuteChanged();
        ChooseStrategyCommand.RaiseCanExecuteChanged();
        SubmitPasswordCommand.RaiseCanExecuteChanged();
        ForgotPasswordCommand.RaiseCanExecuteChanged();
        ResendCodeCommand.RaiseCanExecuteChanged();
        ChooseWorkspaceCommand.RaiseCanExecuteChanged();
        SwitchAccountCommand.RaiseCanExecuteChanged();
        RetryWorkspaceCheckCommand.RaiseCanExecuteChanged();
    }
}
