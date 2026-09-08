using TimiVet.Models;

namespace TimiVet.Services;

public sealed class DemoClinicData
{
    private readonly List<ClinicRequest> _requests;
    private readonly List<WidgetToken> _widgetTokens;
    private ClinicAvailability _availability;
    private FacilitySettingsUpdate _settings;
    private readonly ReferralLink _referralLink = new() { Id = "demo_referral", Slug = "hearth-paw", Status = "active", ClickCount = 4 };

    public DemoClinicData()
    {
        var now = DateTimeOffset.Now;
        _availability = new ClinicAvailability { IntakeStatus = "available", Label = "Available now", StableWaitMin = 15, StableWaitMax = 35, CapacityCount = 3, AcceptsCritical = true, Source = "hospital", Confidence = "high", Note = "Accepting stable urgent-care arrivals.", ReportedAt = now, ExpiresAt = now.AddMinutes(30) };
        _settings = new FacilitySettingsUpdate
        {
            Kind = "urgent",
            Species = ["dog", "cat"],
            Capabilities = ["surgery", "wellness", "vaccines", "emergency"],
            Open24Hours = false,
            AcceptsWalkIns = true,
            ArrivalWindowMinutes = 20,
            BaseExamFeeCents = 18500,
            HoursNote = "Mon–Fri 8am–8pm, Sat 9am–4pm. Closed major holidays.",
            StaffingLevel = "veterinarian",
            StaffingNote = ""
        };
        _widgetTokens =
        [
            new WidgetToken { Id = "demo_widget_1", Label = "Front page badge", Prefix = "twt_demo123", AllowedOrigins = [], Status = "active", CreatedAt = now.AddDays(-9).ToString("O"), LastUsedAt = now.AddHours(-3).ToString("O") }
        ];
        _requests =
        [
            new ClinicRequest { Id = "demo_search_1", SearchId = "search_demo", PublicCode = "TIMI-7K3Q", LocationId = "loc_hearth", TenantId = "tenant_hearth", SearchTarget = true, Status = "pending", Urgency = "urgent", ConcernSummary = "Vomited three times since 7 AM and will not drink water.", TravelMinutes = 11, RequestedAt = now.AddMinutes(-2), RequestExpiresAt = now.AddMinutes(4), Pet = new() { Name = "Milo", Species = "dog", Breed = "German shepherd", WeightLbs = 78 }, Owner = new() { Name = "Avery Cole", Phone = "(510) 555-0126", Email = "avery@example.com" } },
            new ClinicRequest { Id = "demo_search_2", SearchId = "search_demo_2", PublicCode = "TIMI-2D9R", LocationId = "loc_hearth", TenantId = "tenant_hearth", SearchTarget = true, Status = "pending", Urgency = "emergency", RedFlags = ["breathing_difficulty"], ConcernSummary = "Open-mouth breathing at rest with blue-tinged gums for ten minutes.", TravelMinutes = 17, RequestedAt = now.AddMinutes(-1), RequestExpiresAt = now.AddMinutes(5), Pet = new() { Name = "Juniper", Species = "cat", Breed = "Domestic shorthair", WeightLbs = 9 }, Owner = new() { Name = "Morgan Lee", Phone = "(510) 555-0192" } },
            new ClinicRequest { Id = "demo_direct_1", PublicCode = "TIMI-8M4P", LocationId = "loc_hearth", TenantId = "tenant_hearth", SearchTarget = false, Status = "pending", Urgency = "same_day", ConcernSummary = "Limping after a run and avoiding weight on the left front paw.", TravelMinutes = 8, RequestedAt = now.AddMinutes(-4), RequestExpiresAt = now.AddMinutes(3), Pet = new() { Name = "Otis", Species = "dog", Breed = "Golden retriever", WeightLbs = 72 }, Owner = new() { Name = "Sam Rivera", Phone = "(510) 555-0181" } }
        ];
    }

    public ClinicDashboard Dashboard()
    {
        var visible = _requests.OrderByDescending(r => r.Status == "pending").ThenByDescending(r => r.RequestedAt).ToList();
        return new ClinicDashboard
        {
            Location = BuildLocation(),
            Requests = visible,
            Metrics = new ClinicMetrics { Pending = visible.Count(r => r.Status == "pending"), ActiveArrivals = visible.Count(r => new[] { "accepted", "en_route", "arrived", "triaged" }.Contains(r.Status)), CompletedToday = visible.Count(r => r.Status == "completed"), DeclinedToday = visible.Count(r => r.Status == "declined") }
        };
    }

    private ClinicLocation BuildLocation() => new()
    {
        Id = "loc_hearth", TenantId = "tenant_hearth", Name = "Hearth & Paw Urgent Care",
        Address = "22418 Foothill Boulevard, Hayward, CA", Phone = "(510) 555-0148",
        Kind = _settings.Kind, Availability = _availability,
        Policy = new() { Version = 1, DepositRequired = true, DepositAmountCents = 5000, FreeCancelMinutes = 20, CompletedPlatformFeeCents = 2000, NoShowPlatformFeeCents = 500 },
        Species = _settings.Species, Capabilities = _settings.Capabilities, Hours = new() { Note = _settings.HoursNote },
        Open24Hours = _settings.Open24Hours, AcceptsWalkIns = _settings.AcceptsWalkIns, ArrivalWindowMinutes = _settings.ArrivalWindowMinutes,
        BaseExamFeeCents = _settings.BaseExamFeeCents, StaffingLevel = _settings.StaffingLevel, StaffingNote = _settings.StaffingNote,
        StaffingNotice = _settings.StaffingLevel == "veterinary_technician" && !string.IsNullOrWhiteSpace(_settings.StaffingNote) ? _settings.StaffingNote : null
    };

    public void Publish(AvailabilityUpdate update)
    {
        var now = DateTimeOffset.Now;
        _availability = new ClinicAvailability { IntakeStatus = update.IntakeStatus, Label = Label(update.IntakeStatus), StableWaitMin = update.StableWaitMin, StableWaitMax = update.StableWaitMax, CapacityCount = update.CapacityCount, AcceptsCritical = update.AcceptsCritical, Source = "hospital", Confidence = "high", Note = update.Note, ReportedAt = now, ExpiresAt = now.AddMinutes(update.TtlMinutes) };
    }

    public void Decide(string id, ClinicDecision decision)
    {
        var request = _requests.FirstOrDefault(r => r.Id == id) ?? throw new InvalidOperationException("The demo request no longer exists.");
        request.Status = decision.Decision is "decline" ? "declined" : "accepted";
        request.UpdatedAt = DateTimeOffset.Now;
    }

    /// <summary>Mirrors updateClinicLocationSettings — replaces the whole record, same as the Worker
    /// does — and hands back the same shape a real save would.</summary>
    public ClinicLocation UpdateSettings(FacilitySettingsUpdate update)
    {
        _settings = update;
        return BuildLocation();
    }

    public List<WidgetToken> WidgetTokens() => [.. _widgetTokens];

    public WidgetToken CreateWidgetToken(string? label, List<string> allowedOrigins)
    {
        var token = new WidgetToken
        {
            Id = $"demo_widget_{_widgetTokens.Count + 1}",
            Label = label,
            Prefix = $"twt_demo{Random.Shared.Next(100, 999)}",
            AllowedOrigins = allowedOrigins,
            Status = "active",
            CreatedAt = DateTimeOffset.Now.ToString("O"),
            // Shown once, exactly like the real Worker's response — a demo secret still has to look
            // plausible enough that "copy the embed snippet" behaves the same way it would for real.
            Secret = $"demo_secret_{Guid.NewGuid():N}"
        };
        _widgetTokens.Add(token);
        return token;
    }

    public void RevokeWidgetToken(string id)
    {
        var token = _widgetTokens.FirstOrDefault(t => t.Id == id) ?? throw new InvalidOperationException("That demo widget token no longer exists.");
        _widgetTokens.Remove(token);
    }

    public ReferralLink ReferralLinkSnapshot() => _referralLink;

    private static string Label(string status) => status switch { "available" => "Available now", "limited" => "Limited capacity", "confirm_first" => "Confirm first", "critical_only" => "Critical only", "diverting" => "Diverting", "closed" => "Closed", _ => "Unverified" };
}
