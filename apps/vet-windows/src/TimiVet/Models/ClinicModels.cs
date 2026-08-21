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

public sealed class ClinicRequest
{
    public string Id { get; set; } = "";
    public string? SearchId { get; set; }
    public string? PublicCode { get; set; }
    public string LocationId { get; set; } = "";
    public string TenantId { get; set; } = "";
    public PetSummary Pet { get; set; } = new();
    public OwnerSummary Owner { get; set; } = new();
    public string ConcernSummary { get; set; } = "";
    public string Urgency { get; set; } = "urgent";
    public List<string> RedFlags { get; set; } = [];
    public int? TravelMinutes { get; set; }
    public string Status { get; set; } = "pending";
    public DateTimeOffset? RequestedAt { get; set; }
    public DateTimeOffset? RequestExpiresAt { get; set; }
    public DateTimeOffset? UpdatedAt { get; set; }
    public bool SearchTarget { get; set; }

    [JsonIgnore] public string PetLine => $"{Pet.Name} · {Display(Pet.Species)}";
    [JsonIgnore] public string RequestType => SearchTarget ? "MULTI-CLINIC SEARCH" : "DIRECT INTAKE";
    [JsonIgnore] public string TravelLabel => TravelMinutes is null ? "Travel unknown" : $"{TravelMinutes} min away";
    [JsonIgnore] public string RequestedLabel => RequestedAt is null ? "Just now" : RequestedAt.Value.LocalDateTime.ToString("h:mm tt");
    [JsonIgnore] public bool IsEmergency => Urgency == "emergency" || RedFlags.Count > 0;
    private static string Display(string value) => value.Replace('_', ' ').ToUpperInvariant();
}

public sealed class PetSummary
{
    public string Name { get; set; } = "Pet";
    public string Species { get; set; } = "other";
    public string? Breed { get; set; }
    public double? AgeYears { get; set; }
    public double? WeightLbs { get; set; }
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

public sealed class AppSettings
{
    public string ApiBaseUrl { get; set; } = "";
    public string TenantId { get; set; } = "tenant_hearth";
    public string BearerToken { get; set; } = "";
    public int PollSeconds { get; set; } = 6;
    public bool AlertsEnabled { get; set; } = true;
    public bool PlaySound { get; set; } = true;
    public bool MiniWindowTopmost { get; set; } = true;
    public bool StartWithWindows { get; set; }
}
