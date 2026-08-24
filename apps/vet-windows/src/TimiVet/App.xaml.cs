using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using TimiVet.Models;
using TimiVet.Services;
using TimiVet.ViewModels;
using TimiVet.Views;

namespace TimiVet;

public partial class App : System.Windows.Application
{
    private SettingsStore? _store;
    private AppSettings? _settings;
    private CredentialStore? _credentials;
    private ClerkAuthService? _auth;
    private ClinicApiClient? _api;
    private MainViewModel? _viewModel;
    private AlertService? _alerts;
    private MainWindow? _main;
    private MiniWindow? _mini;
    private PeopleWindow? _people;
    public bool IsExiting { get; private set; }

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;

        _store = new SettingsStore();
        _settings = _store.Load();

        // One-time migration: the old build wrote a Clerk bearer token to settings.json in plaintext.
        // Archive it in the DPAPI-protected credential store and blank it from the JSON file immediately.
        _credentials = new CredentialStore();
        var legacyToken = _store.ExtractAndScrubLegacyBearerToken();
        if (!string.IsNullOrEmpty(legacyToken)) _credentials.SaveMigratedLegacyToken(legacyToken);

        _auth = new ClerkAuthService(_credentials);
        _api = new ClinicApiClient(_settings, _auth);

        // Once per launch, from the one place WPF guarantees runs once — not from the view model,
        // whose StartAsync re-runs on reconnects. Fire-and-forget by contract; sign-in has not
        // happened yet and the beacon carries no identifier, so nothing here waits on it.
        _api.TrackEvent("console_opened");

        var session = await EstablishSessionAsync();
        if (session is null)
        {
            Shutdown();
            return;
        }

        _viewModel = new MainViewModel(_store, _settings, _api, _auth);
        _viewModel.ApplySession(session);
        _alerts = new AlertService(_settings);
        _main = new MainWindow(_viewModel);
        _mini = new MiniWindow(_viewModel) { Topmost = _settings.MiniWindowTopmost };

        _viewModel.NewRequestArrived += (_, request) =>
        {
            _alerts.NewRequest(request);
            if (_settings.AutoShowMiniOnNewRequest) ShowMini();
        };
        // "Nothing happens when a request comes in" is impossible to diagnose by waiting for a real
        // patient, so the Test button in Settings plays the same sound the same way.
        _viewModel.TestAlertRequested += (_, _) => _alerts.PreviewAlert();
        _viewModel.SignedOut += (_, _) => ExitApplication();
        _alerts.ShowMainRequested += (_, _) => ShowMain();
        _alerts.ShowMiniRequested += (_, _) => ShowMini();
        _alerts.OpenPeopleRequested += (_, _) => ShowPeople();
        _alerts.ExitRequested += (_, _) => ExitApplication();

        _main.Show();
        _ = _viewModel.StartAsync();
    }

    /// <summary>
    /// Gets to a usable console with as little asked of the operator as the situation allows.
    ///
    /// In order: resume the stored Clerk session silently; if the network is down but this machine has
    /// previously been confirmed as belonging to a veterinary workspace, open the console anyway and let
    /// it reconnect in the background; otherwise show the sign-in window, which starts at "email or
    /// phone" rather than at a Cloudflare Worker URL.
    ///
    /// The one thing that never happens here is a network failure erasing a credential. It used to: a
    /// blanket catch around the restore dropped straight through to interactive sign-in, so a console
    /// opened before the Wi-Fi associated asked a clinic to sign in again — and signing in again is what
    /// replaced the credential, permanently, for a problem that had fixed itself thirty seconds later.
    /// </summary>
    private async Task<SessionDescriptor?> EstablishSessionAsync()
    {
        if (_settings is null || _auth is null || _api is null) return null;

        var restoredButNotClinic = false;
        SessionRestoreOutcome outcome;
        try { outcome = await _auth.RestoreAsync(CancellationToken.None); }
        catch { outcome = SessionRestoreOutcome.Unreachable; }

        if (outcome is SessionRestoreOutcome.Restored or SessionRestoreOutcome.ResumedUnverified)
        {
            try
            {
                var restoredSession = await _api.GetSessionAsync(CancellationToken.None);
                if (restoredSession.Surfaces.Clinic)
                {
                    _auth.RecordClinicSurfaceVerified();
                    return restoredSession;
                }
                restoredButNotClinic = true;
            }
            catch (ClinicApiException ex) when (!ex.IsAuthenticationFailure && _auth.CanResumeClinicSessionOffline)
            {
                // The Worker could not be reached, and this credential has already passed the clinic check
                // on this machine. Sending somebody to a sign-in screen they cannot complete without a
                // network, in order to prove something already proven, helps nobody at a front desk.
                return OfflineClinicSession();
            }
            catch { /* fall through to interactive sign-in */ }
        }

        while (true)
        {
            var signInViewModel = new SignInViewModel(_settings, _auth, _api, _store!);
            // Skip straight to the "no clinic access" outcome when Clerk itself is already signed in —
            // no need to re-collect a Worker URL or identifier that already resolved fine.
            if (restoredButNotClinic) await signInViewModel.EnterAtSessionCheckAsync();
            restoredButNotClinic = false;

            var window = new SignInWindow(signInViewModel);
            var completed = window.ShowDialog();
            if (completed != true) return null;
            if (window.Session is not null) return window.Session;
        }
    }

    /// <summary>
    /// A placeholder descriptor for a resumed-but-unverified launch. It asserts only what the stored
    /// credential already established; the clinic's name, address and role arrive with the first
    /// successful poll, and until then the console says OFFLINE rather than pretending otherwise.
    /// </summary>
    private static SessionDescriptor OfflineClinicSession() => new()
    {
        Authenticated = true,
        Surfaces = new SessionSurfaces { Clinic = true }
    };

    public void ShowMain()
    {
        if (_main is null) return;
        if (_main.WindowState == WindowState.Minimized) _main.WindowState = WindowState.Normal;
        _main.Show(); _main.Activate();
    }

    public void ShowMini()
    {
        if (_mini is null) return;
        if (_mini.WindowState == WindowState.Minimized) _mini.WindowState = WindowState.Normal;
        _mini.Topmost = _viewModel?.Settings.MiniWindowTopmost ?? true;
        _mini.Show(); _mini.Activate();
    }

    public void ShowPeople()
    {
        if (_viewModel is null || _api is null) return;
        if (_people is null)
        {
            _people = new PeopleWindow(new PeopleViewModel(_api, _viewModel.IsAdmin));
            _people.Closed += (_, _) => _people = null;
        }
        _people.Show();
        _people.Activate();
    }

    public void ExitApplication()
    {
        IsExiting = true;
        if (_settings is not null && _store is not null) _store.Save(_settings);
        _people?.Close();
        _mini?.Close(); _main?.Close(); Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _viewModel?.Dispose(); _alerts?.Dispose(); _auth?.Dispose(); base.OnExit(e);
    }
}
