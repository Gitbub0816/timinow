using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;

namespace TimiVet.Models;

public sealed class ClinicDashboard
{
    public ClinicLocation Location { get; set; } = new();
    public List<ClinicRequest> Requests { get; set; } = [];
    public List<ClinicObservation> Observations { get; set; } = [];
    public ClinicMetrics Metrics { get; set; } = new();
}

public sealed class ClinicLocation
{
    public string Id { get; set; } = "";
    public string? TenantId { get; set; }
    public string Name { get; set; } = "Veterinary clinic";
    public string? Address { get; set; }
    public string? Phone { get; set; }
    public string? Kind { get; set; }
    public ClinicAvailability Availability { get; set; } = new();
    public ClinicPolicy Policy { get; set; } = new();
}

public sealed class ClinicAvailability
{
    public string IntakeStatus { get; set; } = "unverified";
    public string? Label { get; set; }
    public int? StableWaitMin { get; set; }
    public int? StableWaitMax { get; set; }
    public int? CapacityCount { get; set; }
    public bool AcceptsCritical { get; set; }
    public string? Source { get; set; }
    public string? Confidence { get; set; }
    public string? Note { get; set; }
    public DateTimeOffset? ReportedAt { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
}

public sealed class ClinicPolicy
{
    public int? Version { get; set; }
    public bool DepositRequired { get; set; }
    public int DepositAmountCents { get; set; }
    public int FreeCancelMinutes { get; set; }
    public int CompletedPlatformFeeCents { get; set; }
    public int NoShowPlatformFeeCents { get; set; }
}

/// <summary>
/// One request on the queue.
/// </summary>
/// <remarks>
/// Raises PropertyChanged so the console can refresh without rebuilding the
/// list. The poll used to Clear() the collection and re-Add() everything, which
/// tells WPF that every row it was showing is gone — so the queue tore itself
/// down and rebuilt six seconds at a time, taking the scroll position, the
/// selection and the keyboard focus with it. Merging into the existing rows
/// only works if a row can say which of its own fields moved, which is what
/// this is for: a request going from pending to offered redraws that badge and
/// nothing else.
/// </remarks>
public sealed class ClinicRequest : INotifyPropertyChanged
{
    public event PropertyChangedEventHandler? PropertyChanged;

    private void Raise([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    /// <summary>
    /// Takes the server's latest version of this request without replacing the
    /// object the list is bound to.
    /// </summary>
    /// <remarks>
    /// Only fields that actually changed raise a notification. A poll that
    /// brings back an identical request therefore does no UI work at all,
    /// which is the difference between a console that sits still and one that
    /// visibly reloads itself while somebody is reading it.
    ///
    /// Computed properties are named explicitly because WPF has no idea they
    /// depend on the fields above them — PetLine will not refresh because
    /// Pet did, and a row would keep the old animal's name beside the new
    /// one's details.
    /// </remarks>
    public void CopyFrom(ClinicRequest latest)
    {
        if (ReferenceEquals(this, latest)) return;
        SearchId = latest.SearchId;
        PublicCode = latest.PublicCode;
        LocationId = latest.LocationId;
        TenantId = latest.TenantId;
        Pet = latest.Pet;
        Owner = latest.Owner;
        ConcernSummary = latest.ConcernSummary;
        Urgency = latest.Urgency;
        RedFlags = latest.RedFlags;
        TravelMinutes = latest.TravelMinutes;
        Status = latest.Status;
        RequestedAt = latest.RequestedAt;
        RequestExpiresAt = latest.RequestExpiresAt;
        UpdatedAt = latest.UpdatedAt;
        SearchTarget = latest.SearchTarget;
        foreach (var computed in new[] { nameof(PetLine), nameof(RequestType), nameof(TravelLabel), nameof(RequestedLabel), nameof(IsEmergency), nameof(OwnerSuppliedMedicalLine), nameof(HasOwnerSuppliedMedical) })
        {
            Raise(computed);
        }
    }

    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return;
        field = value;
        Raise(name);
    }

    public string Id { get; set; } = "";
    private string? _searchId;
    public string? SearchId { get => _searchId; set => Set(ref _searchId, value); }
    private string? _publicCode;
    public string? PublicCode { get => _publicCode; set => Set(ref _publicCode, value); }
    private string _locationId = "";
    public string LocationId { get => _locationId; set => Set(ref _locationId, value); }
    private string _tenantId = "";
    public string TenantId { get => _tenantId; set => Set(ref _tenantId, value); }
    private PetSummary _pet = new();
    public PetSummary Pet { get => _pet; set => Set(ref _pet, value); }
    private OwnerSummary _owner = new();
    public OwnerSummary Owner { get => _owner; set => Set(ref _owner, value); }
    private string _concernSummary = "";
    public string ConcernSummary { get => _concernSummary; set => Set(ref _concernSummary, value); }
    private string _urgency = "urgent";
    public string Urgency { get => _urgency; set => Set(ref _urgency, value); }
    private List<string> _redFlags = [];
    public List<string> RedFlags { get => _redFlags; set => Set(ref _redFlags, value); }
    private int? _travelMinutes;
    public int? TravelMinutes { get => _travelMinutes; set => Set(ref _travelMinutes, value); }
    private string _status = "pending";
    public string Status { get => _status; set => Set(ref _status, value); }
    private DateTimeOffset? _requestedAt;
    public DateTimeOffset? RequestedAt { get => _requestedAt; set => Set(ref _requestedAt, value); }
    private DateTimeOffset? _requestExpiresAt;
    public DateTimeOffset? RequestExpiresAt { get => _requestExpiresAt; set => Set(ref _requestExpiresAt, value); }
    private DateTimeOffset? _updatedAt;
    public DateTimeOffset? UpdatedAt { get => _updatedAt; set => Set(ref _updatedAt, value); }
    private bool _searchTarget;
    public bool SearchTarget { get => _searchTarget; set => Set(ref _searchTarget, value); }

    [JsonIgnore] public string PetLine => $"{Pet.Name} · {Display(Pet.Species)}";
    [JsonIgnore] public string RequestType => SearchTarget ? "MULTI-CLINIC SEARCH" : "DIRECT INTAKE";
    [JsonIgnore] public string TravelLabel => TravelMinutes is null ? "Travel unknown" : $"{TravelMinutes} min away";
    [JsonIgnore] public string RequestedLabel => RequestedAt is null ? "Just now" : RequestedAt.Value.LocalDateTime.ToString("h:mm tt");
    [JsonIgnore] public bool IsEmergency => Urgency == "emergency" || RedFlags.Count > 0;

    /// <summary>
    /// Allergies and medications the owner recorded, labelled as unverified. Empty when there are none,
    /// so the console needs no visibility converter to hide an empty row.
    /// </summary>
    [JsonIgnore]
    public string OwnerSuppliedMedicalLine
    {
        get
        {
            var parts = new List<string>();
            if (!string.IsNullOrWhiteSpace(Pet.Allergies)) parts.Add($"Allergies: {Pet.Allergies!.Trim()}");
            if (!string.IsNullOrWhiteSpace(Pet.Medications)) parts.Add($"Medications: {Pet.Medications!.Trim()}");
            return parts.Count == 0 ? "" : $"Reported by owner, unverified — {string.Join(" · ", parts)}";
        }
    }

    /// <summary>
    /// Whether there is anything owner-supplied to show. The console binds a whole bordered callout to
    /// this rather than to the string: an empty band the colour of a warning, sitting under every request
    /// that has no allergies recorded, teaches the desk to stop looking at that part of the screen.
    /// </summary>
    [JsonIgnore] public bool HasOwnerSuppliedMedical => OwnerSuppliedMedicalLine.Length > 0;

    private static string Display(string value) => value.Replace('_', ' ').ToUpperInvariant();
}

public sealed class PetSummary
{
    public string Name { get; set; } = "Pet";
    public string Species { get; set; } = "other";
    public string? Breed { get; set; }
    public double? AgeYears { get; set; }
    public double? WeightLbs { get; set; }

    /// <summary>
    /// Optional, owner-supplied, unverified. Carried so the desk is not hearing it for the first time
    /// when the animal walks in — not a medical record, and never something to act on without confirming.
    /// </summary>
    public string? Medications { get; set; }
    public string? Allergies { get; set; }
}

public sealed class OwnerSummary
{
    public string Name { get; set; } = "";
    public string Phone { get; set; } = "";
    public string? Email { get; set; }
}

public sealed class ClinicMetrics
{
    public int Pending { get; set; }
    public int ActiveArrivals { get; set; }
    public int CompletedToday { get; set; }
    public int DeclinedToday { get; set; }
}

public sealed class ClinicObservation
{
    public string Milestone { get; set; } = "";
    public DateTimeOffset? ObservedAt { get; set; }
    public int? WaitQuoteMin { get; set; }
    public int? WaitQuoteMax { get; set; }
}

public sealed class AvailabilityUpdate
{
    public string IntakeStatus { get; set; } = "available";
    public int StableWaitMin { get; set; } = 15;
    public int StableWaitMax { get; set; } = 35;
    public int CapacityCount { get; set; } = 3;
    public int TtlMinutes { get; set; } = 30;
    public bool AcceptsCritical { get; set; } = true;
    public string Note { get; set; } = "Accepting stable urgent-care arrivals.";
}

public sealed class ClinicDecision
{
    public string Decision { get; set; } = "offer";
    public string ResponseType { get; set; } = "available_now";
    public DateTimeOffset? AvailableAt { get; set; }
    public int ArrivalWindowMinutes { get; set; } = 30;
    public int HoldMinutes { get; set; } = 5;
    public int WaitMin { get; set; } = 15;
    public int WaitMax { get; set; } = 35;
    public string Note { get; set; } = "";
}

/// <summary>
/// Fixed facts about the deployment this build talks to. Mirrors
/// <c>TimiVetEnvironment.defaultAPIBaseURL</c> in apps/vet-desktop/Sources/TimiVetCore/ClinicModels.swift —
/// the two consoles must point at the same Worker out of the box or a clinic running one on the front desk
/// and the other in the back office sees two different queues.
/// </summary>
public static class TimiVetEnvironment
{
    /// <summary>
    /// Where a fresh install talks to, with nothing typed in anywhere.
    ///
    /// This was "", and an empty address is not a neutral starting point: the console cannot reach
    /// /api/config, so it never learns the Clerk publishable key, so there is no sign-in service to reach
    /// and it says so — which sends whoever is holding the laptop to look at Clerk and at DNS rather than
    /// at a blank field on the first screen. Making a receptionist type a Cloudflare Worker URL before the
    /// product does anything at all was the single worst thing about this client.
    ///
    /// Settings still overrides it; this is only the starting point.
    /// </summary>
    public const string DefaultApiBaseUrl = "https://providers.timinow.pet";
}

public sealed class AppSettings
{
    /// <summary>
    /// A property initializer, unlike the Swift original's, genuinely applies to <c>new AppSettings()</c> —
    /// C# has no separate memberwise initializer to assign over it. What does overwrite it is
    /// <see cref="System.Text.Json.JsonSerializer"/>: a settings.json written by an older build carries
    /// <c>"ApiBaseUrl": ""</c>, and deserializing that puts the blank back. SettingsStore.Load normalizes
    /// it on the way in for exactly that reason — see the comment there.
    /// </summary>
    public string ApiBaseUrl { get; set; } = TimiVetEnvironment.DefaultApiBaseUrl;
    public string TenantId { get; set; } = "tenant_hearth";
    public int PollSeconds { get; set; } = 6;
    public bool AlertsEnabled { get; set; } = true;
    public bool PlaySound { get; set; } = true;
    public bool MiniWindowTopmost { get; set; } = true;
    public bool StartWithWindows { get; set; }

    // Floating console geometry, remembered across launches instead of hardcoded startup coordinates.
    public double? MiniWindowLeft { get; set; }
    public double? MiniWindowTop { get; set; }
    public double? MiniWindowWidth { get; set; }
    public double? MiniWindowHeight { get; set; }
    public bool AutoShowMiniOnNewRequest { get; set; }
}

/// <summary>Envelope for GET /api/session on the Tími Worker.</summary>
public sealed class SessionEnvelope
{
    public SessionDescriptor Session { get; set; } = new();
}

public sealed class SessionDescriptor
{
    public bool Authenticated { get; set; }
    public SessionUser User { get; set; } = new();
    public SessionOrganization? Organization { get; set; }
    public SessionTenant? Tenant { get; set; }
    public SessionLocation? Location { get; set; }
    public bool PlatformAdmin { get; set; }
    public SessionSurfaces Surfaces { get; set; } = new();
    public List<string> RepairedMetadata { get; set; } = [];
}

public sealed class SessionUser
{
    public string Id { get; set; } = "";
    public string? Email { get; set; }
    public string? Name { get; set; }
    public string? Role { get; set; }
    public List<string> Permissions { get; set; } = [];
}

public sealed class SessionOrganization
{
    public string Id { get; set; } = "";
    public string? Slug { get; set; }
}

public sealed class SessionTenant
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Slug { get; set; }
    public string? Status { get; set; }
}

public sealed class SessionLocation
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Address { get; set; }
    public string? Phone { get; set; }
}

public sealed class SessionSurfaces
{
    public bool Customer { get; set; }
    public bool Clinic { get; set; }
    public bool Admin { get; set; }
}

/// <summary>Response shape for GET /api/tenant/members.</summary>
public sealed class TenantMembersResponse
{
    public List<TenantMember> Members { get; set; } = [];
    public List<TenantInvitation> Invitations { get; set; } = [];
}

public sealed class TenantMember
{
    public string UserId { get; set; } = "";
    public string? Email { get; set; }
    public string? Name { get; set; }
    public string Role { get; set; } = "org:member";
    public DateTimeOffset? JoinedAt { get; set; }

    [JsonIgnore] public bool IsAdmin => Role.EndsWith(":admin", StringComparison.OrdinalIgnoreCase) || Role.Equals("admin", StringComparison.OrdinalIgnoreCase);
    [JsonIgnore] public string JoinedLabel => JoinedAt is null ? "" : JoinedAt.Value.LocalDateTime.ToString("MMM d, yyyy");
}

public sealed class TenantInvitation
{
    public string Id { get; set; } = "";
    public string? Email { get; set; }
    public string Role { get; set; } = "org:member";
    public DateTimeOffset? CreatedAt { get; set; }

    [JsonIgnore] public string CreatedLabel => CreatedAt is null ? "" : CreatedAt.Value.LocalDateTime.ToString("MMM d, yyyy");
}

/// <summary>
/// GET /api/config. Reachable without a session on purpose: it is where the Clerk publishable key comes
/// from, which is the one thing the console must have before anybody can sign in.
/// </summary>
public sealed class AppConfig
{
    public string? AppName { get; set; }
    public bool? SignInRequired { get; set; }
    public string? ClerkPublishableKey { get; set; }

    /// <summary>
    /// Present only if the Worker ever starts returning the Clerk Frontend API host outright. Preferred
    /// over decoding the publishable key when it is there, since a key we cannot decode is a dead end and
    /// an explicit host is not.
    /// </summary>
    public string? ClerkFrontendApi { get; set; }
    public bool? DemoMode { get; set; }
    public string? Surface { get; set; }
}

/// <summary>
/// Whether Tími may ring this clinic, and on what number — GET/PATCH /api/clinic/call-preferences.
///
/// A practice with one person at the desk and a phone that is already ringing has a real reason to say no
/// to an automated call, and until these controls existed had no way to say it: every participating clinic
/// ran on the default whether or not that was what it wanted.
/// </summary>
public sealed class CallPreferences
{
    /// <summary>Both the practice-level and site-level flags have to be on; the Worker reports the AND.</summary>
    public bool CallsEnabled { get; set; } = true;
    public bool TenantCallsEnabled { get; set; } = true;
    public bool LocationCallsEnabled { get; set; } = true;

    /// <summary>The number Tími dials. Null means the location's listed phone below.</summary>
    public string? VoicePhone { get; set; }
    public string? LocationPhone { get; set; }

    /// <summary>Absent, or an object with both ends null, means no quiet hours — never half a window.</summary>
    public QuietHours? QuietHours { get; set; }

    [JsonIgnore]
    public string DialledNumberLabel =>
        !string.IsNullOrWhiteSpace(VoicePhone) ? VoicePhone!
        : !string.IsNullOrWhiteSpace(LocationPhone) ? $"{LocationPhone} (clinic's listed number)"
        : "No number on file";
}

public sealed class QuietHours
{
    public string? Start { get; set; }
    public string? End { get; set; }
}

public sealed class CallPreferencesEnvelope
{
    public CallPreferences Preferences { get; set; } = new();
}

/// <summary>
/// Body of PATCH /api/clinic/call-preferences. Every property is nullable and omitted when null so that
/// two administrators editing different settings do not overwrite each other's work — and, more sharply,
/// because the Worker reads an explicitly-sent <c>null</c> as a value rather than as an absence:
/// <c>callsEnabled: null</c> is stored as "off", not as "leave it alone".
/// </summary>
public sealed class CallPreferencesUpdate
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? CallsEnabled { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? VoicePhone { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public QuietHours? QuietHours { get; set; }
}

// ---------------------------------------------------------------- payouts ---

/// <summary>
/// One line of the Tími ledger, as this clinic is allowed to see it.
/// </summary>
/// <remarks>
/// A deliberately thin slice of `payment_ledger`: the clinic gets its own
/// transfers and its own payouts and nothing else. It never sees what the
/// customer's card was charged or what Tími retained — those are on the
/// platform side of the transaction, and putting them on a clinic's screen
/// invites an argument about a number the clinic cannot act on.
/// </remarks>
public sealed class ClinicLedgerEntry
{
    public string Id { get; set; } = "";
    public string OccurredAt { get; set; } = "";
    public string Kind { get; set; } = "";
    public int AmountCents { get; set; }
    public string Status { get; set; } = "";
    /// <summary>The Stripe transfer or payout id, so a clinic reading its own
    /// Express dashboard can match that line to this one.</summary>
    public string? StripeObjectId { get; set; }
    public string? IntakeId { get; set; }

    [JsonIgnore] public string AmountLabel => ClinicMoney.Dollars(AmountCents);
    [JsonIgnore] public string OccurredLabel => ClinicMoney.ShortDate(OccurredAt);
    [JsonIgnore] public string Reference => string.IsNullOrWhiteSpace(StripeObjectId) ? "—" : StripeObjectId!;
}

/// <summary>
/// What this clinic is owed and what Stripe has already sent it.
/// </summary>
/// <remarks>
/// AwaitingPayoutCents is what Tími transferred less what Stripe paid out —
/// not the clinic's Stripe balance, which moves for reasons Tími does not
/// control and would turn this panel into an explanation of Stripe's
/// arithmetic rather than ours.
/// </remarks>
public sealed class ClinicEarnings
{
    public int TransferredCents { get; set; }
    public int PaidOutCents { get; set; }
    public int AwaitingPayoutCents { get; set; }
    public List<ClinicLedgerEntry> Transfers { get; set; } = [];
    public List<ClinicLedgerEntry> Payouts { get; set; } = [];
}

/// <summary>Only what a clinic can act on. Stripe's requirements hash is an
/// operator's problem and stays in the platform console.</summary>
public sealed class ClinicConnectStatus
{
    public string OnboardingStatus { get; set; } = "not_started";
    public bool TransfersEnabled { get; set; }
    public bool PayoutsEnabled { get; set; }
    public string? DisabledReason { get; set; }
}

public sealed class ClinicPayouts
{
    public ClinicEarnings Earnings { get; set; } = new();
    public ClinicConnectStatus? Connect { get; set; }
}

/// <summary>Money and dates, formatted the way the macOS console formats them,
/// so a clinic running one on the front desk and the other in the back office
/// reads the same numbers in the same shape.</summary>
public static class ClinicMoney
{
    public static string Dollars(int cents) => (cents / 100m).ToString("C", System.Globalization.CultureInfo.GetCultureInfo("en-US"));

    public static string ShortDate(string iso)
        => DateTimeOffset.TryParse(iso, out var parsed) ? parsed.LocalDateTime.ToString("d MMM, h:mm tt") : "—";
}
