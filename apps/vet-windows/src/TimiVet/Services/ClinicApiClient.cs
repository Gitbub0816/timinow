using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading;
using TimiVet.Models;

namespace TimiVet.Services;

public sealed class ClinicApiClient
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private readonly DemoClinicData _demo = new();
    private readonly ClerkAuthService _auth;
    private AppSettings _settings;

    public ClinicApiClient(AppSettings settings, ClerkAuthService auth)
    {
        _settings = settings;
        _auth = auth;
    }

    public bool IsDemo => !Uri.TryCreate(_settings.ApiBaseUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps;
    public void UpdateSettings(AppSettings settings) => _settings = settings;

    public async Task<ClinicDashboard> GetDashboardAsync(CancellationToken cancellationToken)
    {
        if (IsDemo) return _demo.Dashboard();
        using var response = await SendAsync(HttpMethod.Get, "/api/clinic/dashboard", null, cancellationToken);
        return await ReadAsync<ClinicDashboard>(response, cancellationToken);
    }

    public async Task<SessionDescriptor> GetSessionAsync(CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Get, "/api/session", null, cancellationToken);
        var envelope = await ReadAsync<SessionEnvelope>(response, cancellationToken);
        return envelope.Session;
    }

    public async Task<TenantMembersResponse> GetTenantMembersAsync(CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Get, "/api/tenant/members", null, cancellationToken);
        return await ReadAsync<TenantMembersResponse>(response, cancellationToken);
    }

    public Task AddTenantMemberAsync(string email, string role, CancellationToken cancellationToken) =>
        SendAndDiscardAsync(HttpMethod.Post, "/api/tenant/members", new { email, role }, cancellationToken);

    public Task ChangeTenantMemberRoleAsync(string userId, string role, CancellationToken cancellationToken) =>
        SendAndDiscardAsync(HttpMethod.Patch, $"/api/tenant/members/{Uri.EscapeDataString(userId)}", new { role }, cancellationToken);

    public Task RemoveTenantMemberAsync(string userId, CancellationToken cancellationToken) =>
        SendAndDiscardAsync(HttpMethod.Delete, $"/api/tenant/members/{Uri.EscapeDataString(userId)}", null, cancellationToken);

    public Task RevokeInvitationAsync(string invitationId, CancellationToken cancellationToken) =>
        SendAndDiscardAsync(HttpMethod.Delete, $"/api/tenant/invitations/{Uri.EscapeDataString(invitationId)}", null, cancellationToken);

    public async Task PublishAvailabilityAsync(AvailabilityUpdate update, CancellationToken cancellationToken)
    {
        if (IsDemo) { _demo.Publish(update); return; }
        using var response = await SendAsync(HttpMethod.Post, "/api/clinic/availability", update, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    public async Task RespondAsync(ClinicRequest item, ClinicDecision decision, CancellationToken cancellationToken)
    {
        if (IsDemo) { _demo.Decide(item.Id, decision); return; }
        object payload = item.SearchTarget
            ? new { decision = decision.Decision, responseType = decision.ResponseType, availableAt = decision.AvailableAt, arrivalWindowMinutes = decision.ArrivalWindowMinutes, holdMinutes = decision.HoldMinutes, waitMin = decision.WaitMin, waitMax = decision.WaitMax, note = decision.Note }
            : new { decision = decision.Decision == "offer" ? "accept" : "decline", arrivalWindowMinutes = decision.ArrivalWindowMinutes, note = decision.Note };
        var path = item.SearchTarget ? $"/api/clinic/search-targets/{Uri.EscapeDataString(item.Id)}/decision" : $"/api/clinic/intakes/{Uri.EscapeDataString(item.Id)}/decision";
        using var response = await SendAsync(HttpMethod.Post, path, payload, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    private async Task SendAndDiscardAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(method, path, body, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    /// <summary>
    /// Sends one request, re-minting the Worker token and retrying exactly once on a 401. Demo headers
    /// (x-demo-role / x-demo-tenant-id) are only ever attached when there is no real Clerk session AND the
    /// resolved host is a localhost/loopback development address — never against a production HTTPS Worker.
    /// </summary>
    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        using var request = await CreateAsync(method, path, body, cancellationToken);
        var response = await _http.SendAsync(request, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Unauthorized && _auth.HasSession)
        {
            response.Dispose();
            await _auth.ForceRefreshAsync(cancellationToken);
            using var retry = await CreateAsync(method, path, body, cancellationToken);
            response = await _http.SendAsync(retry, cancellationToken);
        }
        return response;
    }

    private async Task<HttpRequestMessage> CreateAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        var url = new Uri(new Uri(_settings.ApiBaseUrl.TrimEnd('/') + "/"), path.TrimStart('/'));
        var request = new HttpRequestMessage(method, url);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        if (_auth.HasSession)
        {
            await _auth.EnsureFreshTokenAsync(cancellationToken);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _auth.WorkerToken);
        }
        else if (IsLoopback(url))
        {
            request.Headers.Add("x-demo-role", "clinic");
            request.Headers.Add("x-demo-tenant-id", _settings.TenantId);
        }
        else
        {
            throw new InvalidOperationException("Sign in to Tími before contacting a production Worker.");
        }

        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        return request;
    }

    private static bool IsLoopback(Uri url) => url.IsLoopback || url.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase);

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
