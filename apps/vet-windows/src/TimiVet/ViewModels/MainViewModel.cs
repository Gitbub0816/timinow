using System.Collections.ObjectModel;
using System.IO;
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

    /// <summary>
    /// Which binary this actually is, stamped into the footer.
    /// </summary>
    /// <remarks>
    /// Three separate debugging rounds have been spent on a machine running a
    /// stale copy of this console while everyone believed it was the new one -
    /// a taskbar pin to an old exe, a publish that silently failed and left
    /// the previous binary in place, a copy on a desktop. The executable's own
    /// write time cannot be wrong about which build it is, and putting it
    /// where the company name was costs nothing anyone will miss.
    /// </remarks>
    public string BuildStamp
    {
        get
        {
            try
            {
                var path = Environment.ProcessPath;
                if (string.IsNullOrEmpty(path)) return "Tími NOW · ClearKey Solutions, LLC";
                var written = File.GetLastWriteTime(path);
                return $"Tími NOW · ClearKey Solutions, LLC · built {written:d MMM HH:mm}";
            }
            catch { return "Tími NOW · ClearKey Solutions, LLC"; }
        }
    }

    public AppSettings Settings { get; }
    /// Says whether the thing you just pressed worked, where you pressed it.
    public ToastCenter Toasts { get; } = new(System.Windows.Application.Current?.Dispatcher ?? System.Windows.Threading.Dispatcher.CurrentDispatcher);
    public ObservableCollection<ClinicRequest> Requests { get; } = [];
    public ObservableCollection<ClinicRequest> PendingRequests { get; } = [];
    public IReadOnlyList<string> AvailabilityStatuses { get; } = ["available", "limited", "confirm_first", "critical_only", "diverting", "closed"];
    public IReadOnlyList<string> ResponseTypes { get; } = ["available_now", "available_at", "emergency_intake"];

    private ClinicPayouts _payouts = new();
    public ClinicPayouts Payouts { get => _payouts; set { _payouts = value; Raise(nameof(Payouts)); Raise(nameof(TransferredLabel)); Raise(nameof(PaidOutLabel)); Raise(nameof(AwaitingLabel)); Raise(nameof(HasSettlements)); Raise(nameof(PayoutsNotice)); } }
    private bool _payoutsLoaded;
    public bool PayoutsLoaded { get => _payoutsLoaded; set { _payoutsLoaded = value; Raise(nameof(PayoutsLoaded)); Raise(nameof(PayoutsNotice)); } }

    public string TransferredLabel => ClinicMoney.Dollars(Payouts.Earnings.TransferredCents);
    public string PaidOutLabel => ClinicMoney.Dollars(Payouts.Earnings.PaidOutCents);
    public string AwaitingLabel => ClinicMoney.Dollars(Payouts.Earnings.AwaitingPayoutCents);
    public bool HasSettlements => Payouts.Earnings.Transfers.Count > 0 || Payouts.Earnings.Payouts.Count > 0;

    /// <summary>
    /// What to say when there is nothing in the ledger.
    /// </summary>
    /// <remarks>
    /// A clinic that cannot receive transfers fails nowhere else: deposits are
    /// still collected and its share simply accumulates on Tími's side. This
    /// panel is the only place a practice would ever find out, so the reason
    /// goes here rather than an empty state that reads as "no business yet".
    /// </remarks>
    public string PayoutsNotice
    {
        get
        {
            if (!PayoutsLoaded) return "Loading…";
            if (Payouts.Connect is { TransfersEnabled: false } connect)
            {
                return connect.DisabledReason is { Length: > 0 } reason
                    ? $"Stripe has restricted this clinic's account ({reason}). Nothing can be paid out until that is resolved."
                    : "This clinic's Stripe account is not finished, so Tími cannot pay it yet. Your Tími contact can send the onboarding form again.";
            }
            return HasSettlements
                ? ""
                : "Nothing has been settled yet. A deposit is paid out after the visit is recorded as completed, a no-show, or a late cancellation.";
        }
    }

    public async Task LoadPayoutsAsync()
    {
        try
        {
            Payouts = await _api.GetPayoutsAsync(_lifetime.Token);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception)
        {
            // Silent. Money is not why this console is open, and a practice
            // that has not finished Stripe onboarding should not be told the
            // console is broken every fifteen seconds.
        }
        finally { PayoutsLoaded = true; }
    }

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

    private string _callPolicy = "always";
    private string _voicePhone = "", _quietStart = "", _quietEnd = "", _listedPhone = "";
    private bool _callPreferencesLoaded;

    /// <summary>"always", "console_active", or "never" — validated by the Worker.</summary>
    public string CallPolicy
    {
        get => _callPolicy;
        set
        {
            if (!Set(ref _callPolicy, value)) return;
            // The three radio projections below are all views over this one
            // string, so every change here has to re-announce all of them.
            Raise(nameof(CallPolicyAlways));
            Raise(nameof(CallPolicyConsoleActive));
            Raise(nameof(CallPolicyNever));
        }
    }

    // Radio-button projections of CallPolicy. WPF sets the newly-checked one to
    // true and the previously-checked one to false; only the true write may
    // move the policy, or the unchecking of the old button would clobber it.
    public bool CallPolicyAlways { get => CallPolicy == "always"; set { if (value) CallPolicy = "always"; } }
    public bool CallPolicyConsoleActive { get => CallPolicy == "console_active"; set { if (value) CallPolicy = "console_active"; } }
    public bool CallPolicyNever { get => CallPolicy == "never"; set { if (value) CallPolicy = "never"; } }
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
        _ = LoadPayoutsAsync();
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

            foreach (var request in dashboard.Requests)
            {
                if (request.Status != "pending") continue;
                if (_initialized && _knownPending.Add(request.Id)) NewRequestArrived?.Invoke(this, request);
                else _knownPending.Add(request.Id);
            }
            Merge(Requests, dashboard.Requests);
            Merge(PendingRequests, dashboard.Requests.Where(r => r.Status == "pending").ToList());
            // Restored from the pending list, which is what the queue shows. Restoring
            // from Requests re-selected the request that had just been answered — no longer
            // in the list, so the ListBox immediately set SelectedItem back to null and the
            // decision workspace flickered through the row nobody had chosen.
            if (SelectedRequest is null || !PendingRequests.Contains(SelectedRequest))
            {
                SelectedRequest = PendingRequests.FirstOrDefault();
            }
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
        if (StableWaitMin > StableWaitMax) { Fail("Minimum wait cannot exceed maximum wait."); return; }
        IsBusy = true;
        try { await _api.PublishAvailabilityAsync(new AvailabilityUpdate { IntakeStatus = AvailabilityStatus, StableWaitMin = StableWaitMin, StableWaitMax = StableWaitMax, CapacityCount = CapacityCount, TtlMinutes = TtlMinutes, AcceptsCritical = AcceptsCritical, Note = PublicNote }, _lifetime.Token); Succeed("Live intake status published."); await RefreshAsync(true); }
        catch (Exception ex) { Fail(ex.Message); }
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
        if (!decline && OfferWaitMin > OfferWaitMax) { Fail("Offer minimum wait cannot exceed maximum wait."); return; }
        IsBusy = true;
        try
        {
            var availableDateTime = AvailableAt ?? DateTime.Today;
            if (TimeSpan.TryParse(AvailableTimeText, out var time)) availableDateTime = availableDateTime.Date.Add(time);
            await _api.RespondAsync(request, new ClinicDecision { Decision = decline ? "decline" : "offer", ResponseType = ResponseType, AvailableAt = ResponseType == "available_at" ? new DateTimeOffset(availableDateTime) : null, ArrivalWindowMinutes = ArrivalWindowMinutes, HoldMinutes = HoldMinutes, WaitMin = OfferWaitMin, WaitMax = OfferWaitMax, Note = ClinicNote }, _lifetime.Token);
            // The beacon carries the shape of the decision and nothing that names the clinic, the pet,
            // or the request — /api/analytics is cookieless by contract.
            _api.TrackEvent("decision_made", new Dictionary<string, string> { ["decision"] = decline ? "decline" : "offer" });
            Succeed(decline ? $"Declined {request.Pet.Name}'s request." : request.SearchTarget ? $"Availability offer sent for {request.Pet.Name}." : $"Arrival accepted for {request.Pet.Name}.");
            SelectedRequest = null; ClinicNote = ""; await RefreshAsync(true);
        }
        catch (Exception ex) { Fail(ex.Message); }
        finally { IsBusy = false; }
    }

    /// <summary>
    /// Brings a collection up to date without emptying it first.
    /// </summary>
    /// <remarks>
    /// This was Clear() then Add() for every row, every poll. To WPF that is
    /// "every item you were showing is gone, here are some new ones", so every
    /// six seconds the queue tore down and rebuilt its containers: the list
    /// jumped back to the top under whoever was reading it, the selection was
    /// dropped and reinstated, focus left any control inside a row, and the
    /// whole panel flashed. On a front desk that reads as the app reloading
    /// itself constantly, which is exactly what somebody watching it said.
    ///
    /// Merging touches only what changed. A request already on screen has its
    /// fields updated in place and raises PropertyChanged for the ones that
    /// moved, so a row whose status went pending -> offered redraws that badge
    /// and nothing else. Rows that vanished are removed, new ones inserted at
    /// their server-given position. A poll where nothing changed produces no
    /// UI work at all.
    /// </remarks>
    private static void Merge(ObservableCollection<ClinicRequest> target, IReadOnlyList<ClinicRequest> latest)
    {
        var byId = new Dictionary<string, ClinicRequest>(target.Count);
        foreach (var existing in target) byId[existing.Id] = existing;

        // Gone from the server: removed here. Backwards, so the indexes of the
        // items still to be examined do not shift under the loop.
        var wanted = new HashSet<string>(latest.Select(r => r.Id));
        for (var index = target.Count - 1; index >= 0; index -= 1)
        {
            if (!wanted.Contains(target[index].Id)) target.RemoveAt(index);
        }

        for (var index = 0; index < latest.Count; index += 1)
        {
            var incoming = latest[index];
            if (byId.TryGetValue(incoming.Id, out var existing))
            {
                existing.CopyFrom(incoming);
                var at = target.IndexOf(existing);
                // Order can change — a request that becomes pending sorts to
                // the top — and Move is how a ListBox animates that rather
                // than rebuilding the row.
                if (at != index && index < target.Count) target.Move(at, index);
            }
            else if (index <= target.Count)
            {
                target.Insert(index, incoming);
            }
            else
            {
                target.Add(incoming);
            }
        }
    }

    public async Task LoadCallPreferencesAsync()
    {
        try
        {
            var preferences = await _api.GetCallPreferencesAsync(_lifetime.Token);
            // Copied into fields once, not rebound on every poll: a receptionist half-way through typing a
            // back-line number should not have it replaced under the cursor six seconds later.
            CallPolicy = preferences.CallPolicy;
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
                CallPolicy = CallPolicy,
                VoicePhone = VoicePhone.Trim(),
                QuietHours = quiet
            }, _lifetime.Token);
            CallPolicy = saved.CallPolicy;
            VoicePhone = saved.VoicePhone ?? "";
            QuietStart = saved.QuietHours?.Start ?? "";
            QuietEnd = saved.QuietHours?.End ?? "";
            if (!string.IsNullOrWhiteSpace(saved.LocationPhone)) ListedPhone = saved.LocationPhone!;
            CallPreferencesLoaded = true;
            Succeed(saved.CallPolicy switch
            {
                "never" => "Tími will not call this clinic. Requests still arrive in the console.",
                "console_active" => "Tími will call only while a Tími console is open.",
                _ => "Tími will call this clinic about new requests.",
            });
        }
        catch (Exception ex) { Fail(ex.Message); }
        finally { IsBusy = false; }
    }

    private async Task SaveSettingsAsync()
    {
        IsBusy = true;
        try { _settingsStore.Save(Settings); _api.UpdateSettings(Settings); Succeed("Settings saved."); }
        catch (Exception ex) { Fail(ex.Message); }
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
        catch (Exception ex) { Fail(ex.Message); }
        finally { IsBusy = false; SignedOut?.Invoke(this, EventArgs.Empty); }
    }

    private void ApplyAvailability(ClinicAvailability value)
    {
        AvailabilityStatus = value.IntakeStatus; StableWaitMin = value.StableWaitMin ?? 15; StableWaitMax = value.StableWaitMax ?? 35; CapacityCount = value.CapacityCount ?? 0; AcceptsCritical = value.AcceptsCritical; PublicNote = value.Note ?? "";
        OfferWaitMin = StableWaitMin; OfferWaitMax = StableWaitMax;
    }

    /// <summary>
    /// Reports an outcome where the operator is looking.
    /// </summary>
    /// <remarks>
    /// StatusMessage is kept as well: it is what the connection panel shows and
    /// what a screen reader announces. The toast is what a receptionist sees,
    /// because the panel is at the top of a window whose buttons are at the
    /// bottom of it.
    /// </remarks>
    private void Succeed(string message) { StatusMessage = message; Toasts.Success(message); }

    private void Fail(string message) { StatusMessage = message; Toasts.Failure(message); }

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
