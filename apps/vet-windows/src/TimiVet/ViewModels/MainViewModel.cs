using System.Collections.ObjectModel;
using TimiVet.Models;
using TimiVet.Services;

namespace TimiVet.ViewModels;

public sealed class MainViewModel : ObservableObject, IDisposable
{
    private readonly SettingsStore _settingsStore;
    private readonly ClinicApiClient _api;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly HashSet<string> _knownPending = [];
    private bool _initialized;
    private ClinicRequest? _selectedRequest;
    private bool _isBusy;
    private string _statusMessage = "Connecting to Tími…";
    private string _clinicName = "Tími veterinary console";
    private string _clinicAddress = "";
    private string _connectionMode = "INTERACTIVE DEMO";
    private int _pending;
    private int _activeArrivals;
    private int _completedToday;
    private int _declinedToday;

    public MainViewModel(SettingsStore settingsStore)
    {
        _settingsStore = settingsStore;
        Settings = settingsStore.Load();
        _api = new ClinicApiClient(Settings);
        RefreshCommand = new AsyncCommand(() => RefreshAsync(false), () => !IsBusy);
        PublishCommand = new AsyncCommand(PublishAsync, () => !IsBusy);
        OfferCommand = new AsyncCommand(() => RespondAsync(false), () => SelectedRequest is not null && !IsBusy);
        DeclineCommand = new AsyncCommand(() => RespondAsync(true), () => SelectedRequest is not null && !IsBusy);
        SaveSettingsCommand = new AsyncCommand(SaveSettingsAsync, () => !IsBusy);
    }

    public AppSettings Settings { get; }
    public ObservableCollection<ClinicRequest> Requests { get; } = [];
    public ObservableCollection<ClinicRequest> PendingRequests { get; } = [];
    public IReadOnlyList<string> AvailabilityStatuses { get; } = ["available", "limited", "confirm_first", "critical_only", "diverting", "closed"];
    public IReadOnlyList<string> ResponseTypes { get; } = ["available_now", "available_at", "emergency_intake"];

    public event EventHandler<ClinicRequest>? NewRequestArrived;
    public AsyncCommand RefreshCommand { get; }
    public AsyncCommand PublishCommand { get; }
    public AsyncCommand OfferCommand { get; }
    public AsyncCommand DeclineCommand { get; }
    public AsyncCommand SaveSettingsCommand { get; }

    public ClinicRequest? SelectedRequest
    {
        get => _selectedRequest;
        set { if (Set(ref _selectedRequest, value)) { if (value?.IsEmergency == true) ResponseType = "emergency_intake"; OfferCommand.RaiseCanExecuteChanged(); DeclineCommand.RaiseCanExecuteChanged(); } }
    }
    public bool IsBusy { get => _isBusy; private set { if (Set(ref _isBusy, value)) RaiseCommands(); } }
    public string StatusMessage { get => _statusMessage; private set => Set(ref _statusMessage, value); }
    public string ClinicName { get => _clinicName; private set => Set(ref _clinicName, value); }
    public string ClinicAddress { get => _clinicAddress; private set => Set(ref _clinicAddress, value); }
    public string ConnectionMode { get => _connectionMode; private set => Set(ref _connectionMode, value); }
    public int Pending { get => _pending; private set => Set(ref _pending, value); }
    public int ActiveArrivals { get => _activeArrivals; private set => Set(ref _activeArrivals, value); }
    public int CompletedToday { get => _completedToday; private set => Set(ref _completedToday, value); }
    public int DeclinedToday { get => _declinedToday; private set => Set(ref _declinedToday, value); }

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

    public async Task StartAsync()
    {
        await RefreshAsync(true);
        _ = PollLoopAsync(_lifetime.Token);
    }

    public async Task RefreshAsync(bool initial)
    {
        if (IsBusy && !initial) return;
        IsBusy = true;
        try
        {
            var dashboard = await _api.GetDashboardAsync(_lifetime.Token);
            ClinicName = dashboard.Location.Name;
            ClinicAddress = dashboard.Location.Address ?? "";
            ConnectionMode = _api.IsDemo ? "INTERACTIVE DEMO" : "LIVE CLOUDFLARE CONNECTION";
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
            StatusMessage = $"Updated {DateTime.Now:h:mm:ss tt} · next check in {Math.Clamp(Settings.PollSeconds, 3, 60)} sec";
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception ex) { StatusMessage = $"Connection issue · {ex.Message}"; }
        finally { IsBusy = false; }
    }

    private async Task PollLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(Settings.PollSeconds, 3, 60)), token); await RefreshAsync(false); }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
        }
    }

    private async Task PublishAsync()
    {
        if (StableWaitMin > StableWaitMax) { StatusMessage = "Minimum wait cannot exceed maximum wait."; return; }
        IsBusy = true;
        try { await _api.PublishAvailabilityAsync(new AvailabilityUpdate { IntakeStatus = AvailabilityStatus, StableWaitMin = StableWaitMin, StableWaitMax = StableWaitMax, CapacityCount = CapacityCount, TtlMinutes = TtlMinutes, AcceptsCritical = AcceptsCritical, Note = PublicNote }, _lifetime.Token); StatusMessage = "Live intake status published."; await RefreshAsync(true); }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    private async Task RespondAsync(bool decline)
    {
        var request = SelectedRequest; if (request is null) return;
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

    private async Task SaveSettingsAsync()
    {
        IsBusy = true;
        try { _settingsStore.Save(Settings); _api.UpdateSettings(Settings); ConnectionMode = _api.IsDemo ? "INTERACTIVE DEMO" : "LIVE CLOUDFLARE CONNECTION"; StatusMessage = "Settings saved."; await RefreshAsync(true); }
        catch (Exception ex) { StatusMessage = ex.Message; }
        finally { IsBusy = false; }
    }

    private void ApplyAvailability(ClinicAvailability value)
    {
        AvailabilityStatus = value.IntakeStatus; StableWaitMin = value.StableWaitMin ?? 15; StableWaitMax = value.StableWaitMax ?? 35; CapacityCount = value.CapacityCount ?? 0; AcceptsCritical = value.AcceptsCritical; PublicNote = value.Note ?? "";
        OfferWaitMin = StableWaitMin; OfferWaitMax = StableWaitMax;
    }

    private void RaiseCommands() { RefreshCommand.RaiseCanExecuteChanged(); PublishCommand.RaiseCanExecuteChanged(); OfferCommand.RaiseCanExecuteChanged(); DeclineCommand.RaiseCanExecuteChanged(); SaveSettingsCommand.RaiseCanExecuteChanged(); }
    public void Dispose() { _lifetime.Cancel(); _lifetime.Dispose(); }
}
