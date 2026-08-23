using System.Collections.ObjectModel;
using System.Net.NetworkInformation;
using System.Threading;
using TimiVet.Models;
using TimiVet.Services;

namespace TimiVet.ViewModels;

/// <summary>How the console is currently getting on with the Worker, said plainly.</summary>
public enum ConsoleConnectionState
{
    Connecting,
    Live,
    Demo,
    Reconnecting,
    Offline,
    SignInRequired
}

public sealed class MainViewModel : ObservableObject, IDisposable
{
    private readonly SettingsStore _settingsStore;
    private readonly ClinicApiClient _api;
    private readonly ClerkAuthService _auth;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly HashSet<string> _knownPending = [];
    private bool _initialized;
    private ClinicRequest? _selectedRequest;
    private bool _isBusy;
    private string _statusMessage = "Connecting to Tími…";
    private string _clinicName = "Tími veterinary console";
    private string _clinicAddress = "";
    private string _tenantName = "";
    private string _userRole = "";
    private int _pending;
    private int _activeArrivals;
    private int _completedToday;
    private int _declinedToday;

    public MainViewModel(SettingsStore settingsStore, AppSettings settings, ClinicApiClient api, ClerkAuthService auth)
    {
        _settingsStore = settingsStore;
        Settings = settings;
        _api = api;
        _auth = auth;
        RefreshCommand = new AsyncCommand(() => RefreshAsync(false), () => !IsBusy);
        ReconnectCommand = new AsyncCommand(ReconnectNowAsync, () => !IsBusy);
        PublishCommand = new AsyncCommand(PublishAsync, () => !IsBusy);
        OfferCommand = new AsyncCommand(() => RespondAsync(SelectedRequest, false), () => SelectedRequest is not null && !IsBusy);
        DeclineCommand = new AsyncCommand(() => RespondAsync(SelectedRequest, true), () => SelectedRequest is not null && !IsBusy);
        AcceptRequestCommand = new AsyncCommand<ClinicRequest>(request => AnswerAsync(request, decline: false), request => request is not null && !IsBusy);
        DeclineRequestCommand = new AsyncCommand<ClinicRequest>(request => AnswerAsync(request, decline: true), request => request is not null && !IsBusy);
        SaveSettingsCommand = new AsyncCommand(SaveSettingsAsync, () => !IsBusy);
        SaveCallPreferencesCommand = new AsyncCommand(SaveCallPreferencesAsync, () => !IsBusy && IsAdmin);
        SignOutCommand = new AsyncCommand(SignOutAsync, () => !IsBusy);
        OpenPeopleCommand = new RelayCommand(() => OpenPeopleRequested?.Invoke(this, EventArgs.Empty));
        TestAlertCommand = new RelayCommand(() => TestAlertRequested?.Invoke(this, EventArgs.Empty));

        // A clinic PC that finishes booting before its Wi-Fi associates, a switch rebooted overnight, a
        // laptop carried between rooms: the network coming back is a fact the OS already knows, and
        // waiting out a sixty-second backoff after it does is a minute of a queue nobody is watching.
        NetworkChange.NetworkAvailabilityChanged += OnNetworkAvailabilityChanged;
        NetworkChange.NetworkAddressChanged += OnNetworkAddressChanged;
    }

    public AppSettings Settings { get; }
    public ObservableCollection<ClinicRequest> Requests { get; } = [];
    public ObservableCollection<ClinicRequest> PendingRequests { get; } = [];
    public IReadOnlyList<string> AvailabilityStatuses { get; } = ["available", "limited", "confirm_first", "critical_only", "diverting", "closed"];
    public IReadOnlyList<string> ResponseTypes { get; } = ["available_now", "available_at", "emergency_intake"];

    public event EventHandler<ClinicRequest>? NewRequestArrived;
    public event EventHandler? OpenPeopleRequested;
    public event EventHandler? SignedOut;
    public event EventHandler? TestAlertRequested;

    public AsyncCommand RefreshCommand { get; }
    public AsyncCommand ReconnectCommand { get; }
    public AsyncCommand PublishCommand { get; }
    public AsyncCommand OfferCommand { get; }
    public AsyncCommand DeclineCommand { get; }
    public AsyncCommand<ClinicRequest> AcceptRequestCommand { get; }
    public AsyncCommand<ClinicRequest> DeclineRequestCommand { get; }
    public AsyncCommand SaveSettingsCommand { get; }
    public AsyncCommand SaveCallPreferencesCommand { get; }
    public AsyncCommand SignOutCommand { get; }
    public RelayCommand OpenPeopleCommand { get; }
    public RelayCommand TestAlertCommand { get; }

    public ClinicRequest? SelectedRequest
    {
        get => _selectedRequest;
        set { if (Set(ref _selectedRequest, value)) { if (value?.IsEmergency == true) ResponseType = "emergency_intake"; OfferCommand.RaiseCanExecuteChanged(); DeclineCommand.RaiseCanExecuteChanged(); } }
    }
    public bool IsBusy { get => _isBusy; private set { if (Set(ref _isBusy, value)) RaiseCommands(); } }
    public string StatusMessage { get => _statusMessage; private set => Set(ref _statusMessage, value); }
    public string ClinicName { get => _clinicName; private set => Set(ref _clinicName, value); }
    public string ClinicAddress { get => _clinicAddress; private set => Set(ref _clinicAddress, value); }
    public string TenantName { get => _tenantName; private set => Set(ref _tenantName, value); }
    public string UserRole { get => _userRole; private set => Set(ref _userRole, value); }
    public bool IsAdmin => UserRole.EndsWith(":admin", StringComparison.OrdinalIgnoreCase) || UserRole.Equals("admin", StringComparison.OrdinalIgnoreCase);
    public int Pending { get => _pending; private set => Set(ref _pending, value); }
    public int ActiveArrivals { get => _activeArrivals; private set => Set(ref _activeArrivals, value); }
    public int CompletedToday { get => _completedToday; private set => Set(ref _completedToday, value); }
    public int DeclinedToday { get => _declinedToday; private set => Set(ref _declinedToday, value); }

    // ---- Connection state -------------------------------------------------
    //
    // A console that silently stops updating is worse than one that is plainly down: the queue looks empty
    // because it is stale, and nobody can tell the difference from across the room. Every state below is
    // shown on the left rail, in the header, and on the floating panel.

    private ConsoleConnectionState _connectionState = ConsoleConnectionState.Connecting;
    private string _connectionDetail = "Reaching the Tími Worker…";
    private int _consecutiveFailures;
    private DateTimeOffset? _lastSuccessfulRefresh;

    public ConsoleConnectionState ConnectionState
    {
        get => _connectionState;
        private set { if (Set(ref _connectionState, value)) { Raise(nameof(ConnectionMode)); Raise(nameof(IsConnectionHealthy)); } }
    }

    /// <summary>The headline shown in the left rail's CURRENT MODE panel.</summary>
    public string ConnectionMode => ConnectionState switch
    {
        ConsoleConnectionState.Live => "LIVE CLOUDFLARE CONNECTION",
        ConsoleConnectionState.Demo => "INTERACTIVE DEMO",
        ConsoleConnectionState.Reconnecting => "RECONNECTING",
        ConsoleConnectionState.Offline => "OFFLINE — QUEUE IS STALE",
        ConsoleConnectionState.SignInRequired => "SIGN-IN REQUIRED",
        _ => "CONNECTING"
    };

    public string ConnectionDetail { get => _connectionDetail; private set => Set(ref _connectionDetail, value); }

    /// <summary>Drives the colour of the connection badge. Demo counts as healthy; it is working as asked.</summary>
    public bool IsConnectionHealthy => ConnectionState is ConsoleConnectionState.Live or ConsoleConnectionState.Demo;

    private string _availabilityStatus = "available";
    private int _stableWaitMin = 15, _stableWaitMax = 35, _capacityCount = 3, _ttlMinutes = 30;
    private bool _acceptsCritical = true;
    private string _publicNote = "Accepting stable urgent-care arrivals.";
    public string AvailabilityStatus { get => _availabilityStatus; set => Set(ref _availabilityStatus, value); }
    public int StableWaitMin { get => _stableWaitMin; set => Set(ref _stableWaitMin, value); }
    public int StableWaitMax { get => _stableWaitMax; set => Set(ref _stableWaitMax, value); }
    public int CapacityCount { get => _capacityCount; set => Set(ref _capacityCount, value); }
    public int TtlMinutes { get => _ttlMinutes; set => Set(ref _ttlMinutes, value); }
    public bool AcceptsCritical { get => _acceptsCritical; set => Set(ref _acceptsCritical, value); }
    public string PublicNote { get => _publicNote; set => Set(ref _publicNote, value); }

    private string _responseType = "available_now", _clinicNote = "", _availableTimeText = DateTime.Now.AddMinutes(30).ToString("h:mm tt");
    private DateTime? _availableAt = DateTime.Now.AddMinutes(30);
    private int _arrivalWindowMinutes = 30, _holdMinutes = 5, _offerWaitMin = 15, _offerWaitMax = 35;
    public string ResponseType { get => _responseType; set => Set(ref _responseType, value); }
    public DateTime? AvailableAt { get => _availableAt; set => Set(ref _availableAt, value); }
    public string AvailableTimeText { get => _availableTimeText; set => Set(ref _availableTimeText, value); }
    public int ArrivalWindowMinutes { get => _arrivalWindowMinutes; set => Set(ref _arrivalWindowMinutes, value); }
    public int HoldMinutes { get => _holdMinutes; set => Set(ref _holdMinutes, value); }
    public int OfferWaitMin { get => _offerWaitMin; set => Set(ref _offerWaitMin, value); }
    public int OfferWaitMax { get => _offerWaitMax; set => Set(ref _offerWaitMax, value); }
    public string ClinicNote { get => _clinicNote; set => Set(ref _clinicNote, value); }

    // ---- Calling preferences ---------------------------------------------

    private bool _callsEnabled = true;
    private string _voicePhone = "", _quietStart = "", _quietEnd = "", _listedPhone = "";
    private bool _callPreferencesLoaded;

    public bool CallsEnabled { get => _callsEnabled; set => Set(ref _callsEnabled, value); }
    public string VoicePhone { get => _voicePhone; set => Set(ref _voicePhone, value); }
    public string QuietStart { get => _quietStart; set => Set(ref _quietStart, value); }
    public string QuietEnd { get => _quietEnd; set => Set(ref _quietEnd, value); }

    /// <summary>The clinic's listed number, shown as the fallback when no dedicated voice line is set.</summary>
    public string ListedPhone
    {
        get => _listedPhone;
        private set { if (Set(ref _listedPhone, value)) Raise(nameof(ListedPhoneHint)); }
    }

    /// <summary>
    /// Spelled out as a sentence rather than assembled in XAML with StringFormat, because the sentence
    /// contains an apostrophe and a binding expression's own quoting rules eat it.
    /// </summary>
    public string ListedPhoneHint => string.IsNullOrWhiteSpace(ListedPhone) ? "" : $"Listed number: {ListedPhone}";
    public bool CallPreferencesLoaded { get => _callPreferencesLoaded; private set => Set(ref _callPreferencesLoaded, value); }

    /// <summary>Applies the descriptor from GET /api/session so the left rail shows the real workspace, not the dashboard's echo.</summary>
    public void ApplySession(SessionDescriptor session)
    {
        TenantName = session.Tenant?.Name ?? "";
        ClinicName = session.Location?.Name ?? session.Tenant?.Name ?? "Tími veterinary console";
        ClinicAddress = session.Location?.Address ?? "";
        UserRole = session.User.Role ?? "";
        if (!string.IsNullOrWhiteSpace(session.Location?.Phone)) ListedPhone = session.Location!.Phone!;
        Raise(nameof(IsAdmin));
        SaveCallPreferencesCommand.RaiseCanExecuteChanged();

        // A launch that resumed offline opens with a placeholder descriptor: authenticated, clinic
        // surface, and nothing else, because there was no network to ask. Recognising that here is what
        // sends the console back for the real one on its first successful poll, instead of leaving a
        // generic clinic name and a disabled calling-preferences panel up for the rest of the shift.
        _sessionApplied = session.Tenant is not null || session.Location is not null || !string.IsNullOrEmpty(session.User.Id);
    }

    private bool _sessionApplied;

    /// <summary>Fetches the workspace identity when the console started without it.</summary>
    private async Task EnsureSessionAppliedAsync()
    {
        if (_sessionApplied) return;
        try { ApplySession(await _api.GetSessionAsync(_lifetime.Token)); }
        catch (Exception ex)
        {
            // Never fatal and never the operator's problem: the queue is already on screen, and the next
            // successful poll asks again.
            System.Diagnostics.Debug.WriteLine($"Session identity unavailable: {ex.Message}");
        }
    }

    public async Task StartAsync()
    {
        await RefreshAsync(true);
        _ = LoadCallPreferencesAsync();
        _ = PollLoopAsync(_lifetime.Token);
    }

    public async Task RefreshAsync(bool initial)
    {
        if (IsBusy && !initial) return;
        IsBusy = true;
        try
        {
            var dashboard = await _api.GetDashboardAsync(_lifetime.Token);
            Pending = dashboard.Metrics.Pending; ActiveArrivals = dashboard.Metrics.ActiveArrivals; CompletedToday = dashboard.Metrics.CompletedToday; DeclinedToday = dashboard.Metrics.DeclinedToday;
            ApplyAvailability(dashboard.Location.Availability);

            var selectedId = SelectedRequest?.Id;
            Requests.Clear(); PendingRequests.Clear();
            foreach (var request in dashboard.Requests)
            {
                Requests.Add(request);
                if (request.Status == "pending")
                {
                    PendingRequests.Add(request);
                    if (_initialized && _knownPending.Add(request.Id)) NewRequestArrived?.Invoke(this, request);
                    else _knownPending.Add(request.Id);
                }
            }
            SelectedRequest = Requests.FirstOrDefault(r => r.Id == selectedId) ?? PendingRequests.FirstOrDefault();
            _initialized = true;
            MarkConnected();
            await EnsureSessionAppliedAsync();
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (ClinicApiException ex) { MarkDisconnected(ex.Message, ex.IsAuthenticationFailure); }
        catch (Exception ex) { MarkDisconnected(ex.Message, authenticationFailure: false); }
        finally { IsBusy = false; }
    }

    private void MarkConnected()
    {
        _consecutiveFailures = 0;
        _lastSuccessfulRefresh = DateTimeOffset.Now;
        ConnectionState = _api.IsDemo ? ConsoleConnectionState.Demo : ConsoleConnectionState.Live;
        var seconds = NextDelaySeconds;
        ConnectionDetail = $"Updated {DateTime.Now:h:mm:ss tt} · next check in {seconds} sec";
        StatusMessage = ConnectionDetail;
    }

    /// <summary>
    /// Says what is actually happening rather than dropping a one-line exception into the status bar and
    /// carrying on as if the numbers on screen were current.
    ///
    /// Being refused is not the same as not being answered, and the two need different words: a 401 that
    /// survived the token retry means this credential is finished and somebody has to sign in, while a
    /// timeout means wait. Guessing wrong in either direction is expensive — one strands a clinic on a
    /// stale queue, the other throws away a working session over a dropped packet.
    /// </summary>
    private void MarkDisconnected(string reason, bool authenticationFailure)
    {
        _consecutiveFailures++;
        var retryIn = NextDelaySeconds;
        if (authenticationFailure)
        {
            ConnectionState = ConsoleConnectionState.SignInRequired;
            ConnectionDetail = $"Tími would not accept this session — {reason} Sign out and back in to continue.";
        }
        else
        {
            ConnectionState = _consecutiveFailures >= 3 ? ConsoleConnectionState.Offline : ConsoleConnectionState.Reconnecting;
            var since = _lastSuccessfulRefresh is { } last ? $" Last update {last.LocalDateTime:h:mm:ss tt}." : "";
            ConnectionDetail = $"{reason} Trying again in {retryIn} sec (attempt {_consecutiveFailures}).{since}";
        }
        StatusMessage = ConnectionDetail;
    }

    /// <summary>
    /// How long to wait before the next attempt: the configured interval while things are working, and a
    /// widening backoff once they are not. Hammering an unreachable Worker every six seconds does not
    /// bring it back any sooner and does fill a clinic's connection with retries.
    /// </summary>
    private static readonly int[] BackoffSeconds = [5, 10, 20, 40, 60];

    public int NextDelaySeconds => _consecutiveFailures == 0
        ? Math.Clamp(Settings.PollSeconds, 3, 60)
        : BackoffSeconds[Math.Min(_consecutiveFailures - 1, BackoffSeconds.Length - 1)];

    private CancellationTokenSource? _sleepCancellation;

    private async Task PollLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            using var sleep = CancellationTokenSource.CreateLinkedTokenSource(token);
            _sleepCancellation = sleep;
            try { await Task.Delay(TimeSpan.FromSeconds(NextDelaySeconds), sleep.Token); }
            catch (OperationCanceledException) { /* woken early, or shutting down */ }
            finally { _sleepCancellation = null; }
            if (token.IsCancellationRequested) break;
            await RefreshAsync(false);
        }
    }

    /// <summary>Cuts the current wait short so the next attempt happens now.</summary>
    private void WakePoll()
    {
        try { _sleepCancellation?.Cancel(); }
        catch (ObjectDisposedException) { /* the loop moved on by itself; nothing to wake */ }
    }

    private void OnNetworkAvailabilityChanged(object? sender, NetworkAvailabilityEventArgs e)
    {
        if (e.IsAvailable) WakePoll();
    }

    private void OnNetworkAddressChanged(object? sender, EventArgs e) => WakePoll();

    /// <summary>Try again right now, from the button an operator presses when they can see the queue is stale.</summary>
    private async Task ReconnectNowAsync()
    {
        _consecutiveFailures = 0;
        ConnectionState = ConsoleConnectionState.Connecting;
        ConnectionDetail = $"Reaching {_api.ConfiguredAddress}…";
        StatusMessage = ConnectionDetail;
        await RefreshAsync(true);
        if (!CallPreferencesLoaded) await LoadCallPreferencesAsync();
        WakePoll();
    }

    private async Task PublishAsync()
    {
        if (StableWaitMin > StableWaitMax) { StatusMessage = "Minimum wait cannot exceed maximum wait."; return; }
        IsBusy = true;
        try { await _api.PublishAvailabilityAsync(new AvailabilityUpdate { IntakeStatus = AvailabilityStatus, StableWaitMin = StableWaitMin, StableWaitMax = StableWaitMax, CapacityCount = CapacityCount, TtlMinutes = TtlMinutes, AcceptsCritical = AcceptsCritical, Note = PublicNote }, _lifetime.Token); StatusMessage = "Live intake status published."; await RefreshAsync(true); }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    /// <summary>
    /// Answer one request without opening the workspace first.
    ///
    /// Every response used to go through the decision workspace: select the row, read four number fields,
    /// press a button. That is the right screen for shaping an offer and the wrong one for the ordinary
    /// case, which is "yes, usual window" or "no, we're full" — and it was the only thing the floating
    /// panel could offer at all, so an alert about a patient led to "Open decision workspace" rather than
    /// to an answer.
    ///
    /// The workspace's current values are used as they stand, which is what makes this one press: they are
    /// the clinic's own defaults until somebody changes them.
    /// </summary>
    private async Task AnswerAsync(ClinicRequest request, bool decline)
    {
        SelectedRequest = request;
        await RespondAsync(request, decline);
    }

    private async Task RespondAsync(ClinicRequest? request, bool decline)
    {
        if (request is null) return;
        if (!decline && OfferWaitMin > OfferWaitMax) { StatusMessage = "Offer minimum wait cannot exceed maximum wait."; return; }
        IsBusy = true;
        try
        {
            var availableDateTime = AvailableAt ?? DateTime.Today;
            if (TimeSpan.TryParse(AvailableTimeText, out var time)) availableDateTime = availableDateTime.Date.Add(time);
            await _api.RespondAsync(request, new ClinicDecision { Decision = decline ? "decline" : "offer", ResponseType = ResponseType, AvailableAt = ResponseType == "available_at" ? new DateTimeOffset(availableDateTime) : null, ArrivalWindowMinutes = ArrivalWindowMinutes, HoldMinutes = HoldMinutes, WaitMin = OfferWaitMin, WaitMax = OfferWaitMax, Note = ClinicNote }, _lifetime.Token);
            StatusMessage = decline ? $"Declined {request.Pet.Name}'s request." : request.SearchTarget ? $"Availability offer sent for {request.Pet.Name}." : $"Arrival accepted for {request.Pet.Name}.";
            SelectedRequest = null; ClinicNote = ""; await RefreshAsync(true);
        }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    public async Task LoadCallPreferencesAsync()
    {
        try
        {
            var preferences = await _api.GetCallPreferencesAsync(_lifetime.Token);
            // Copied into fields once, not rebound on every poll: a receptionist half-way through typing a
            // back-line number should not have it replaced under the cursor six seconds later.
            CallsEnabled = preferences.CallsEnabled;
            VoicePhone = preferences.VoicePhone ?? "";
            QuietStart = preferences.QuietHours?.Start ?? "";
            QuietEnd = preferences.QuietHours?.End ?? "";
            if (!string.IsNullOrWhiteSpace(preferences.LocationPhone)) ListedPhone = preferences.LocationPhone!;
            CallPreferencesLoaded = true;
        }
        catch (Exception ex)
        {
            // Not fatal, and not worth taking over the status line the queue is using: the section shows
            // its own "could not load" state instead.
            CallPreferencesLoaded = false;
            System.Diagnostics.Debug.WriteLine($"Calling preferences unavailable: {ex.Message}");
        }
    }

    private async Task SaveCallPreferencesAsync()
    {
        IsBusy = true;
        try
        {
            var start = QuietStart.Trim();
            var end = QuietEnd.Trim();
            // Both ends or neither. Half a quiet-hours window is not a window, and the Worker refuses it
            // rather than storing something it would have to ignore at three in the morning.
            var quiet = start.Length == 0 && end.Length == 0
                ? new QuietHours { Start = "", End = "" }
                : new QuietHours { Start = start, End = end };
            var saved = await _api.UpdateCallPreferencesAsync(new CallPreferencesUpdate
            {
                CallsEnabled = CallsEnabled,
                VoicePhone = VoicePhone.Trim(),
                QuietHours = quiet
            }, _lifetime.Token);
            CallsEnabled = saved.CallsEnabled;
            VoicePhone = saved.VoicePhone ?? "";
            QuietStart = saved.QuietHours?.Start ?? "";
            QuietEnd = saved.QuietHours?.End ?? "";
            if (!string.IsNullOrWhiteSpace(saved.LocationPhone)) ListedPhone = saved.LocationPhone!;
            CallPreferencesLoaded = true;
            StatusMessage = saved.CallsEnabled
                ? "Tími will call this clinic about new requests."
                : "Tími will not call this clinic. Requests still arrive in the console.";
        }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task SaveSettingsAsync()
    {
        IsBusy = true;
        try { _settingsStore.Save(Settings); _api.UpdateSettings(Settings); StatusMessage = "Settings saved."; }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
        await ReconnectNowAsync();
    }

    /// <summary>Clears the Clerk session (server-side and local DPAPI store) and asks the shell to exit,
    /// since re-establishing a fresh sign-in inside a live console would require tearing down every
    /// window that already carries the old tenant's data. Relaunching shows the sign-in flow again.</summary>
    private async Task SignOutAsync()
    {
        IsBusy = true;
        try { StatusMessage = "Signing out…"; await _auth.SignOutAsync(_lifetime.Token); }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; SignedOut?.Invoke(this, EventArgs.Empty); }
    }

    private void ApplyAvailability(ClinicAvailability value)
    {
        AvailabilityStatus = value.IntakeStatus; StableWaitMin = value.StableWaitMin ?? 15; StableWaitMax = value.StableWaitMax ?? 35; CapacityCount = value.CapacityCount ?? 0; AcceptsCritical = value.AcceptsCritical; PublicNote = value.Note ?? "";
        OfferWaitMin = StableWaitMin; OfferWaitMax = StableWaitMax;
    }

    private void RaiseCommands()
    {
        RefreshCommand.RaiseCanExecuteChanged();
        ReconnectCommand.RaiseCanExecuteChanged();
        PublishCommand.RaiseCanExecuteChanged();
        OfferCommand.RaiseCanExecuteChanged();
        DeclineCommand.RaiseCanExecuteChanged();
        AcceptRequestCommand.RaiseCanExecuteChanged();
        DeclineRequestCommand.RaiseCanExecuteChanged();
        SaveSettingsCommand.RaiseCanExecuteChanged();
        SaveCallPreferencesCommand.RaiseCanExecuteChanged();
        SignOutCommand.RaiseCanExecuteChanged();
    }

    public void Dispose()
    {
        NetworkChange.NetworkAvailabilityChanged -= OnNetworkAvailabilityChanged;
        NetworkChange.NetworkAddressChanged -= OnNetworkAddressChanged;
        _lifetime.Cancel();
        _lifetime.Dispose();
    }
}
