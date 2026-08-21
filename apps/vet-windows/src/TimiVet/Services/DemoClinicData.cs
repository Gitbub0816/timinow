using TimiVet.Models;

namespace TimiVet.Services;

public sealed class DemoClinicData
{
    private readonly List<ClinicRequest> _requests;
    private ClinicAvailability _availability;

    public DemoClinicData()
    {
        var now = DateTimeOffset.Now;
        _availability = new ClinicAvailability { IntakeStatus = "available", Label = "Available now", StableWaitMin = 15, StableWaitMax = 35, CapacityCount = 3, AcceptsCritical = true, Source = "hospital", Confidence = "high", Note = "Accepting stable urgent-care arrivals.", ReportedAt = now, ExpiresAt = now.AddMinutes(30) };
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
            Location = new ClinicLocation { Id = "loc_hearth", TenantId = "tenant_hearth", Name = "Hearth & Paw Urgent Care", Address = "22418 Foothill Boulevard, Hayward, CA", Phone = "(510) 555-0148", Kind = "urgent", Availability = _availability, Policy = new() { Version = 1, DepositRequired = true, DepositAmountCents = 5000, FreeCancelMinutes = 20, CompletedPlatformFeeCents = 2000, NoShowPlatformFeeCents = 500 } },
            Requests = visible,
            Metrics = new ClinicMetrics { Pending = visible.Count(r => r.Status == "pending"), ActiveArrivals = visible.Count(r => new[] { "accepted", "en_route", "arrived", "triaged" }.Contains(r.Status)), CompletedToday = visible.Count(r => r.Status == "completed"), DeclinedToday = visible.Count(r => r.Status == "declined") }
        };
    }

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

    private static string Label(string status) => status switch { "available" => "Available now", "limited" => "Limited capacity", "confirm_first" => "Confirm first", "critical_only" => "Critical only", "diverting" => "Diverting", "closed" => "Closed", _ => "Unverified" };
}
