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
        _viewModel.SignedOut += (_, _) => ExitApplication();
        _alerts.ShowMainRequested += (_, _) => ShowMain();
        _alerts.ShowMiniRequested += (_, _) => ShowMini();
        _alerts.OpenPeopleRequested += (_, _) => ShowPeople();
        _alerts.ExitRequested += (_, _) => ExitApplication();

        _main.Show();
        _ = _viewModel.StartAsync();
    }

    /// <summary>
    /// Restores a previously persisted Clerk session where possible; otherwise shows the custom sign-in
    /// window, looping through workspace/no-clinic-access outcomes until either a clinic session is
    /// established or the user cancels. The console never appears without a tenant-bearing session.
    /// </summary>
    private async Task<SessionDescriptor?> EstablishSessionAsync()
    {
        if (_settings is null || _auth is null || _api is null) return null;

        var restoredButNotClinic = false;
        if (!string.IsNullOrWhiteSpace(_settings.ApiBaseUrl))
        {
            try
            {
                if (await _auth.TryRestoreAsync(_settings.ApiBaseUrl, CancellationToken.None))
                {
                    var restoredSession = await _api.GetSessionAsync(CancellationToken.None);
                    if (restoredSession.Surfaces.Clinic) return restoredSession;
                    restoredButNotClinic = true;
                }
            }
            catch { /* fall through to interactive sign-in */ }
        }

        while (true)
        {
            var signInViewModel = new SignInViewModel(_settings, _auth, _api, _store!);
            // Skip straight to the "no clinic access" outcome when Clerk itself is already signed in —
            // no need to re-collect a Worker URL, identifier, or password that already resolved fine.
            if (restoredButNotClinic) await signInViewModel.EnterAtSessionCheckAsync();
            restoredButNotClinic = false;

            var window = new SignInWindow(signInViewModel);
            var completed = window.ShowDialog();
            if (completed != true) return null;
            if (window.Session is not null) return window.Session;
        }
    }

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
