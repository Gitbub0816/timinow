using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using TimiVet.Models;

namespace TimiVet.Services;

/// <summary>
/// A failure talking to the Tími Worker, carrying the HTTP status when there was one.
///
/// The status is what lets the console tell "the Worker refused this credential" apart from "there is no
/// network right now". Both used to arrive as an <see cref="InvalidOperationException"/> with a sentence
/// in it, so the poll loop had no way to decide between reconnecting quietly and asking somebody to sign
/// in — and it always chose one of them wrongly.
/// </summary>
public sealed class ClinicApiException(string message, HttpStatusCode? statusCode = null) : Exception(message)
{
    public HttpStatusCode? StatusCode { get; } = statusCode;

    /// <summary>The Worker rejected who we are, rather than failing to answer.</summary>
    public bool IsAuthenticationFailure => StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden;

    /// <summary>Nothing answered at all — DNS, TLS, a timeout, a captive portal. Retry, do not sign out.</summary>
    public bool IsUnreachable => StatusCode is null;
}

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

    /// <summary>The address actually in use, so an error can quote it. A blank one is the most common
    /// cause of "could not reach Clerk" and the least visible thing on the screen.</summary>
    public string ConfiguredAddress =>
        string.IsNullOrWhiteSpace(_settings.ApiBaseUrl) ? "no Worker address" : _settings.ApiBaseUrl.Trim();

    public async Task<ClinicDashboard> GetDashboardAsync(CancellationToken cancellationToken)
    {
        if (IsDemo) return _demo.Dashboard();
        using var response = await SendAsync(HttpMethod.Get, "/api/clinic/dashboard", null, cancellationToken);
        return await ReadAsync<ClinicDashboard>(response, cancellationToken);
    }

    /// <summary>
    /// GET /api/clinic/payouts — what Tími has sent this clinic and what Stripe has paid on.
    /// </summary>
    /// <remarks>
    /// Answers an empty set rather than throwing when payments are not configured. A practice that has
    /// not finished Stripe onboarding still opens this panel, and an error where three zeroes belong
    /// reads as a broken console rather than as an account that is not set up yet.
    /// </remarks>
    public async Task<ClinicPayouts> GetPayoutsAsync(CancellationToken cancellationToken)
    {
        if (IsDemo) return new ClinicPayouts();
        using var response = await SendAsync(HttpMethod.Get, "/api/clinic/payouts", null, cancellationToken);
        return await ReadAsync<ClinicPayouts>(response, cancellationToken);
    }

    /// <summary>
    /// GET /api/config — the Clerk publishable key, and therefore the first request the console ever
    /// makes. Answered to anyone by the Worker, and sent without a session by <see cref="CreateAsync"/>.
    /// </summary>
    public async Task<AppConfig> GetConfigAsync(CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Get, "/api/config", null, cancellationToken);
        return await ReadAsync<AppConfig>(response, cancellationToken);
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

    // ---- Calling preferences (GET/PATCH /api/clinic/call-preferences) ----

    public async Task<CallPreferences> GetCallPreferencesAsync(CancellationToken cancellationToken)
    {
        if (IsDemo) return new CallPreferences { CallPolicy = "always", CallsEnabled = true, LocationPhone = "(510) 555-0148" };
        using var response = await SendAsync(HttpMethod.Get, "/api/clinic/call-preferences", null, cancellationToken);
        var envelope = await ReadAsync<CallPreferencesEnvelope>(response, cancellationToken);
        return envelope.Preferences;
    }

    /// <summary>
    /// PATCH, not POST, and only the fields being changed — see <see cref="CallPreferencesUpdate"/> for
    /// why a null that reaches the wire is a setting rather than an omission. Reading these is open to
    /// everybody on the team; writing them is an administrator's call, and the Worker enforces that.
    /// </summary>
    public async Task<CallPreferences> UpdateCallPreferencesAsync(CallPreferencesUpdate update, CancellationToken cancellationToken)
    {
        if (IsDemo)
        {
            var policy = update.CallPolicy ?? "always";
            return new CallPreferences
            {
                CallPolicy = policy,
                CallsEnabled = policy != "never",
                VoicePhone = string.IsNullOrWhiteSpace(update.VoicePhone) ? null : update.VoicePhone,
                LocationPhone = "(510) 555-0148",
                QuietHours = update.QuietHours
            };
        }
        using var response = await SendAsync(HttpMethod.Patch, "/api/clinic/call-preferences", update, cancellationToken);
        var envelope = await ReadAsync<CallPreferencesEnvelope>(response, cancellationToken);
        return envelope.Preferences;
    }

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

    // ---- Analytics (POST /api/analytics) --------------------------------

    /// <summary>
    /// Fire-and-forget beacon to POST /api/analytics.
    /// </summary>
    /// <remarks>
    /// Deliberately not routed through <see cref="CreateAsync"/>: the endpoint is public and cookieless,
    /// so the beacon must carry no Worker token, demo header, or any other identifier. It is never
    /// awaited and every failure is swallowed whole — a metrics beacon that can surface an error, or
    /// hold up an intake decision, in a clinic's console has its priorities backwards.
    /// </remarks>
    public void TrackEvent(string name, Dictionary<string, string>? meta = null)
    {
        if (IsDemo || string.IsNullOrWhiteSpace(_settings.ApiBaseUrl)) return;
        var url = new Uri(new Uri(_settings.ApiBaseUrl.Trim().TrimEnd('/') + "/"), "api/analytics");
        _ = Task.Run(async () =>
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, url)
                {
                    Content = JsonContent.Create(new AnalyticsPayload { Events = [new AnalyticsEvent { Name = name, Meta = meta }] }, options: Json)
                };
                using var response = await _http.SendAsync(request, CancellationToken.None);
            }
            catch
            {
                // Silent by contract: a failed beacon must never reach a screen, a toast, or a log line
                // somebody at a front desk might read as the console being broken.
            }
        });
    }

    /// <summary>The console-analytics wire shape: {events: [{name, path?, meta?}]}, at most 25 events,
    /// and — because the endpoint is cookieless by design — nothing that identifies the operator or the
    /// tenant.</summary>
    private sealed class AnalyticsPayload
    {
        public List<AnalyticsEvent> Events { get; set; } = [];
    }

    private sealed class AnalyticsEvent
    {
        public string Name { get; set; } = "";
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        public Dictionary<string, string>? Meta { get; set; }
    }

    private async Task SendAndDiscardAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        using var response = await SendAsync(method, path, body, cancellationToken);
        await EnsureSuccessAsync(response, cancellationToken);
    }

    /// <summary>
    /// Sends one request, re-minting the Worker token and retrying exactly once on a 401. The retry goes
    /// through <see cref="CreateAsync"/> again rather than reusing the first message, so it genuinely
    /// carries the newly minted token instead of replaying the dead one that caused the 401.
    ///
    /// Demo headers (x-demo-role / x-demo-tenant-id) are only ever attached when there is no real Clerk
    /// session AND the resolved host is a localhost/loopback development address — never against a
    /// production HTTPS Worker.
    /// </summary>
    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        var response = await SendOnceAsync(method, path, body, cancellationToken);
        if (response.StatusCode == HttpStatusCode.Unauthorized && _auth.HasSession)
        {
            response.Dispose();
            await _auth.ForceRefreshAsync(cancellationToken);
            response = await SendOnceAsync(method, path, body, cancellationToken);
        }
        return response;
    }

    /// <summary>
    /// One attempt, with transport failures translated into a <see cref="ClinicApiException"/> carrying no
    /// status. That absence is load-bearing: it is how the poll loop knows the difference between the
    /// Worker saying no and nothing having answered at all.
    /// </summary>
    private async Task<HttpResponseMessage> SendOnceAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        try
        {
            using var request = await CreateAsync(method, path, body, cancellationToken);
            return await _http.SendAsync(request, cancellationToken);
        }
        catch (HttpRequestException ex)
        {
            throw new ClinicApiException($"Could not reach {ConfiguredAddress} — {ex.Message}");
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ClinicApiException($"{ConfiguredAddress} did not answer within 20 seconds.");
        }
        catch (ClerkApiException ex)
        {
            // Minting the Worker token is part of sending the request, so a Clerk refusal has to arrive
            // wearing the same clothes as a Worker refusal — otherwise the caller sees an exception type
            // it does not recognise, files it under weather, and reconnects forever against a session
            // that has genuinely been revoked.
            throw new ClinicApiException(ex.Message, ex.IsCredentialRejected ? HttpStatusCode.Unauthorized : null);
        }
    }

    private async Task<HttpRequestMessage> CreateAsync(HttpMethod method, string path, object? body, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(_settings.ApiBaseUrl))
            throw new ClinicApiException("Enter the HTTPS address of your Tími Worker in Settings.");
        var url = new Uri(new Uri(_settings.ApiBaseUrl.Trim().TrimEnd('/') + "/"), path.TrimStart('/'));
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
        else if (!IsPublic(url))
        {
            request.Dispose();
            throw new ClinicApiException("Sign in to Tími before contacting a production Worker.");
        }

        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        return request;
    }

    /// <summary>
    /// The endpoints the Worker answers to anyone, and that the console must reach <em>before</em> it can
    /// sign in.
    ///
    /// /api/config is where the Clerk publishable key comes from, so demanding a session in order to fetch
    /// it is a deadlock: no config, no Clerk host, no sign-in, no session, no config. The macOS console
    /// reported it as "Could not read https://providers.timinow.pet/api/config — Sign in to Tími before
    /// contacting a production Worker", which reads as a Worker or a Clerk problem and is neither; the
    /// request was never sent. This client only escaped it because ClerkAuthService used to keep a private
    /// HttpClient to fetch the config behind the gate's back. That back door is gone, so the exemption
    /// here is what keeps sign-in possible at all.
    /// </summary>
    private static bool IsPublic(Uri url) => url.AbsolutePath.TrimEnd('/').EndsWith("/api/config", StringComparison.OrdinalIgnoreCase);

    private static bool IsLoopback(Uri url) => url.IsLoopback || url.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase);

    private static async Task<T> ReadAsync<T>(HttpResponseMessage response, CancellationToken token)
    {
        await EnsureSuccessAsync(response, token);
        try
        {
            return await response.Content.ReadFromJsonAsync<T>(Json, token)
                ?? throw new ClinicApiException("The Tími API returned an empty response.", response.StatusCode);
        }
        catch (JsonException)
        {
            throw new ClinicApiException("The Tími API returned a response Tími could not read.", response.StatusCode);
        }
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken token)
    {
        if (response.IsSuccessStatusCode) return;
        var raw = await response.Content.ReadAsStringAsync(token);
        string? message = null;
        try
        {
            using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(raw) ? "{}" : raw);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object)
            {
                if (root.TryGetProperty("message", out var value) && value.ValueKind == JsonValueKind.String) message = value.GetString();
                else if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String) message = error.GetString();
            }
        }
        catch (JsonException)
        {
            // An HTML error page from a proxy is not the Worker speaking. Fall through to the status.
        }
        throw new ClinicApiException(
            string.IsNullOrWhiteSpace(message) ? $"Tími API error {(int)response.StatusCode}." : message!,
            response.StatusCode);
    }
}
