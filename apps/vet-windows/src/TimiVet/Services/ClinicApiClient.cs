using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using TimiVet.Models;

namespace TimiVet.Services;

public sealed class ClinicApiClient
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly DemoClinicData _demo = new();
    private AppSettings _settings;

    public ClinicApiClient(AppSettings settings) => _settings = settings;
    public bool IsDemo => !Uri.TryCreate(_settings.ApiBaseUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps;
    public void UpdateSettings(AppSettings settings) => _settings = settings;

    public async Task<ClinicDashboard> GetDashboardAsync(CancellationToken cancellationToken)
    {
        if (IsDemo) return _demo.Dashboard();
        using var request = Create(HttpMethod.Get, "/api/clinic/dashboard");
        using var response = await _http.SendAsync(request, cancellationToken);
        return await ReadAsync<ClinicDashboard>(response, cancellationToken);
    }

    public async Task PublishAvailabilityAsync(AvailabilityUpdate update, CancellationToken cancellationToken)
    {
        if (IsDemo) { _demo.Publish(update); return; }
        using var request = Create(HttpMethod.Post, "/api/clinic/availability", update);
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task RespondAsync(ClinicRequest item, ClinicDecision decision, CancellationToken cancellationToken)
    {
        if (IsDemo) { _demo.Decide(item.Id, decision); return; }
        object payload = item.SearchTarget
            ? new { decision = decision.Decision, responseType = decision.ResponseType, availableAt = decision.AvailableAt, arrivalWindowMinutes = decision.ArrivalWindowMinutes, holdMinutes = decision.HoldMinutes, waitMin = decision.WaitMin, waitMax = decision.WaitMax, note = decision.Note }
            : new { decision = decision.Decision == "offer" ? "accept" : "decline", arrivalWindowMinutes = decision.ArrivalWindowMinutes, note = decision.Note };
        var path = item.SearchTarget ? $"/api/clinic/search-targets/{Uri.EscapeDataString(item.Id)}/decision" : $"/api/clinic/intakes/{Uri.EscapeDataString(item.Id)}/decision";
        using var request = Create(HttpMethod.Post, path, payload);
        using var response = await _http.SendAsync(request, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    private HttpRequestMessage Create(HttpMethod method, string path, object? body = null)
    {
        var url = new Uri(new Uri(_settings.ApiBaseUrl.TrimEnd('/') + "/"), path.TrimStart('/'));
        var request = new HttpRequestMessage(method, url);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (!string.IsNullOrWhiteSpace(_settings.BearerToken)) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _settings.BearerToken.Trim());
        else { request.Headers.Add("x-demo-role", "clinic"); request.Headers.Add("x-demo-tenant-id", _settings.TenantId); }
        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        return request;
    }

    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken token)
    {
        await EnsureSuccessAsync(response, token);
        return await response.Content.ReadFromJsonAsync<T>(Json, token) ?? throw new InvalidOperationException("The Tími API returned an empty response.");
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken token)
    {
        if (response.IsSuccessStatusCode) return;
        var raw = await response.Content.ReadAsStringAsync(token);
        string message;
        try { message = JsonDocument.Parse(raw).RootElement.TryGetProperty("message", out var value) ? value.GetString() ?? raw : raw; }
        catch { message = raw; }
        throw new InvalidOperationException(string.IsNullOrWhiteSpace(message) ? $"Tími API error {(int)response.StatusCode}." : message);
    }
}
