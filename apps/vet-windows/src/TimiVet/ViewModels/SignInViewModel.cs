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
    Code,
    Workspace,
    NotClinicWorkspace
}

/// <summary>
/// Drives the Tími-designed sign-in window through Clerk's Frontend API (see ClerkAuthService).
/// No Clerk-hosted or Clerk-branded UI is ever mounted — every step here is a plain WPF screen.
/// Email and phone one-time codes are the only sign-in methods offered: the password step and the
/// Google/Apple OAuth buttons were removed on the owner's instruction, and any other strategy Clerk
/// reports for an account is filtered out rather than shown as a button this window cannot honor.
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
    private string _code = "";
    private int _resendSecondsRemaining;
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
        ChooseStrategyCommand = new AsyncCommand<ClerkFirstFactor>(ChooseStrategyAsync, _ => !IsBusy);
        ResendCodeCommand = new AsyncCommand(ResendCodeAsync, () => !IsBusy && _resendSecondsRemaining == 0);
        ChooseWorkspaceCommand = new AsyncCommand<ClerkOrganizationMembershipResource>(ChooseWorkspaceAsync, _ => !IsBusy);
        BackToIdentifierCommand = new RelayCommand(() => { ErrorText = ""; Step = SignInStep.Identifier; });
        SwitchAccountCommand = new AsyncCommand(SwitchAccountAsync, () => !IsBusy);
        RetryWorkspaceCheckCommand = new AsyncCommand(() => CheckSessionAsync(), () => !IsBusy);
        // The address step is skipped whenever the default Worker answers, so this is the only way back to
        // it — for a clinic on a private deployment, or for anyone testing against a loopback Worker.
        ChangeWorkerAddressCommand = new RelayCommand(() => { ErrorText = ""; Step = SignInStep.WorkerUrl; });

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
                Raise(nameof(IsCodeStep)); Raise(nameof(IsWorkspaceStep)); Raise(nameof(IsNotClinicStep));
            }
        }
    }

    public bool IsWorkerUrlStep => Step == SignInStep.WorkerUrl;
    public bool IsIdentifierStep => Step == SignInStep.Identifier;
    public bool IsStrategyStep => Step == SignInStep.Strategy;
    public bool IsCodeStep => Step == SignInStep.Code;
    public bool IsWorkspaceStep => Step == SignInStep.Workspace;
    public bool IsNotClinicStep => Step == SignInStep.NotClinicWorkspace;

    public bool IsBusy { get => _isBusy; private set { if (Set(ref _isBusy, value)) RaiseCommands(); } }
    public string ErrorText { get => _errorText; private set => Set(ref _errorText, value); }
    public string Identifier { get => _identifier; set => Set(ref _identifier, value); }
    public string Code { get => _code; set => Set(ref _code, value); }
    public int ResendSecondsRemaining { get => _resendSecondsRemaining; private set => Set(ref _resendSecondsRemaining, value); }
    public string? SafeIdentifier => _chosenFactor?.SafeIdentifier ?? Identifier;
    public SessionDescriptor? Session => _session;

    public ObservableCollection<ClerkFirstFactor> StrategyOptions { get; } = [];
    public ObservableCollection<ClerkOrganizationMembershipResource> WorkspaceOptions { get; } = [];

    public AsyncCommand ContinueWorkerUrlCommand { get; }
    public AsyncCommand ContinueIdentifierCommand { get; }
    public AsyncCommand<ClerkFirstFactor> ChooseStrategyCommand { get; }
    public AsyncCommand ResendCodeCommand { get; }
    public AsyncCommand<ClerkOrganizationMembershipResource> ChooseWorkspaceCommand { get; }
    public RelayCommand BackToIdentifierCommand { get; }
    public AsyncCommand SwitchAccountCommand { get; }
    public AsyncCommand RetryWorkspaceCheckCommand { get; }
    public RelayCommand ChangeWorkerAddressCommand { get; }

    /// <summary>
    /// Reaches the configured Worker and resolves its Clerk instance before anybody types anything.
    ///
    /// The first thing this window used to do was demand a Cloudflare Worker URL — from a receptionist,
    /// on a machine somebody else set up, before the product would do a single thing. There is a correct
    /// answer for every clinic Tími runs, it is the same answer, and it is the default; the address step
    /// now exists only for the deployments where it is not.
    ///
    /// When the default cannot be reached the address step still appears, but carrying the reason rather
    /// than a blank field: which address was tried, and what came back.
    /// </summary>
    public async Task StartAsync()
    {
        // Only from the opening step. This runs off the window's Loaded event, which also fires when the
        // shell has already steered this view model somewhere — a restored Clerk session with no clinic
        // access lands on the "not a veterinary workspace" screen before the window is ever shown, and
        // bootstrapping over the top of that would drop somebody back at the identifier field with no
        // account of why they were sent there.
        if (Step != SignInStep.WorkerUrl) return;
        // A session restored from disk already knows its Clerk instance; asking the Worker again would
        // only add a round trip in front of a field that is ready to type into.
        if (_auth.FrontendApiBase is not null) { Step = SignInStep.Identifier; return; }

        var address = Settings.ApiBaseUrl.Trim();
        if (string.IsNullOrWhiteSpace(address)) return;
        IsBusy = true;
        try
        {
            var config = await _api.GetConfigAsync(CancellationToken.None);
            _auth.UseFrontendApi(config, address);
            Step = SignInStep.Identifier;
        }
        catch (Exception ex)
        {
            ErrorText = $"Could not reach {address} — {ex.Message}";
            Step = SignInStep.WorkerUrl;
        }
        finally { IsBusy = false; }
    }

    private async Task ContinueWorkerUrlAsync()
    {
        ErrorText = "";
        var url = Settings.ApiBaseUrl.Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && !uri.IsLoopback))
        {
            ErrorText = $"Enter the full HTTPS URL of your Tími Worker, or leave it as {TimiVetEnvironment.DefaultApiBaseUrl}.";
            return;
        }
        IsBusy = true;
        try
        {
            _settingsStore.Save(Settings);
            _api.UpdateSettings(Settings);
            // Through the gated client on purpose. /api/config is exempt from the sign-in requirement
            // there, and routing it that way is what keeps the exemption honest instead of decorative.
            var config = await _api.GetConfigAsync(CancellationToken.None);
            _auth.UseFrontendApi(config, url);
            Step = SignInStep.Identifier;
        }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task ContinueIdentifierAsync()
    {
        if (string.IsNullOrWhiteSpace(Identifier)) { ErrorText = "Enter your email or phone number."; return; }
        ErrorText = "";
        IsBusy = true;
        try
        {
            var state = await _auth.StartSignInAsync(Identifier.Trim(), CancellationToken.None);
            _signInId = state.SignInId;
            StrategyOptions.Clear();
            // One-time codes only. Clerk reports every first factor the account could use — password
            // included — and a strategy button this window cannot honor is a dead end on the very first
            // screen a clinic sees.
            foreach (var factor in state.SupportedFirstFactors)
            {
                if (factor.Strategy is "email_code" or "phone_code") StrategyOptions.Add(factor);
            }

            if (StrategyOptions.Count == 0)
                ErrorText = "This account has no email address or phone number Tími can send a code to. Ask your workspace administrator to add one.";
            else if (StrategyOptions.Count == 1)
                await ChooseStrategyAsync(StrategyOptions[0]);
            else
                Step = SignInStep.Strategy;
        }
        catch (ClerkApiException ex) { ErrorText = ex.Message; }
        catch (Exception ex) { ErrorText = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task ChooseStrategyAsync(ClerkFirstFactor factor)
    {
        if (_signInId is null) return;
        ErrorText = "";
        _chosenFactor = factor;

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

    public async Task SubmitCodeAsync(string code)
    {
        if (_signInId is null || _chosenFactor is null) return;
        ErrorText = "";
        IsBusy = true;
        try
        {
            var state = await _auth.AttemptFirstFactorAsync(_signInId, _chosenFactor.Strategy, code, CancellationToken.None);
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
        if (state.Status == ClerkSignInStatus.Complete && state.SessionId is not null)
        {
            await AfterSignedInAsync();
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
    /// code step needed) but the last check found no clinic surface — jumps straight to that outcome.
    /// </summary>
    public Task EnterAtSessionCheckAsync() => CheckSessionAsync();

    private async Task CheckSessionAsync()
    {
        ErrorText = "";
        IsBusy = true;
        try
        {
            _session = await _api.GetSessionAsync(CancellationToken.None);
            if (_session.Surfaces.Clinic)
            {
                // Recorded so a later launch that cannot reach Clerk may resume straight into the console
                // instead of asking for a sign-in it has no network to complete. Only a credential that
                // has passed this check ever gets that treatment.
                _auth.RecordClinicSurfaceVerified();
                SignedIn?.Invoke(this, _session);
            }
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
            Identifier = ""; Code = ""; _signInId = null; _chosenFactor = null; _selectedWorkspace = null;
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
        ChooseStrategyCommand.RaiseCanExecuteChanged();
        ResendCodeCommand.RaiseCanExecuteChanged();
        ChooseWorkspaceCommand.RaiseCanExecuteChanged();
        SwitchAccountCommand.RaiseCanExecuteChanged();
        RetryWorkspaceCheckCommand.RaiseCanExecuteChanged();
    }
}
