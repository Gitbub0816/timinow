using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TimiVet.Services;

public static class ClerkSignInStatus
{
    public const string Complete = "complete";
    public const string NeedsFirstFactor = "needs_first_factor";
    public const string NeedsSecondFactor = "needs_second_factor";
    public const string NeedsNewPassword = "needs_new_password";
}

public sealed class ClerkApiException(string message, HttpStatusCode statusCode) : Exception(message)
{
    public HttpStatusCode StatusCode { get; } = statusCode;
}

public sealed class ClerkFirstFactor
{
    public string Strategy { get; set; } = "";
    [JsonPropertyName("email_address_id")] public string? EmailAddressId { get; set; }
    [JsonPropertyName("phone_number_id")] public string? PhoneNumberId { get; set; }
    [JsonPropertyName("safe_identifier")] public string? SafeIdentifier { get; set; }
    public bool Primary { get; set; }
}

public sealed class ClerkVerificationResource
{
    public string? Status { get; set; }
    public string? Strategy { get; set; }
    [JsonPropertyName("external_verification_redirect_url")] public string? ExternalVerificationRedirectUrl { get; set; }
}

public sealed class ClerkSignInResource
{
    public string? Id { get; set; }
    public string? Status { get; set; }
    [JsonPropertyName("supported_first_factors")] public List<ClerkFirstFactor>? SupportedFirstFactors { get; set; }
    [JsonPropertyName("created_session_id")] public string? CreatedSessionId { get; set; }
    [JsonPropertyName("first_factor_verification")] public ClerkVerificationResource? FirstFactorVerification { get; set; }

    [JsonIgnore]
    public string? ExternalVerificationRedirectUrl => FirstFactorVerification?.ExternalVerificationRedirectUrl;
}

public sealed class ClerkSessionResource
{
    public string Id { get; set; } = "";
    public string? Status { get; set; }
    [JsonPropertyName("last_active_organization_id")] public string? LastActiveOrganizationId { get; set; }
}

public sealed class ClerkClientResource
{
    public List<ClerkSessionResource> Sessions { get; set; } = [];
    [JsonPropertyName("last_active_session_id")] public string? LastActiveSessionId { get; set; }
}

public sealed class ClerkTokenResource
{
    public string Jwt { get; set; } = "";
}

public sealed class ClerkOrganizationResource
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Slug { get; set; }
}

public sealed class ClerkOrganizationMembershipResource
{
    public string Id { get; set; } = "";
    public ClerkOrganizationResource? Organization { get; set; }
    public string? Role { get; set; }
}

/// <summary>Snapshot returned to the UI after each Clerk client-API call so the sign-in view model can render the next step.</summary>
public sealed class ClerkAuthState
{
    public string? SignInId { get; set; }
    public string Status { get; set; } = "";
    public List<ClerkFirstFactor> SupportedFirstFactors { get; set; } = [];
    public string? SessionId { get; set; }
}

/// <summary>
/// Drives Clerk's Frontend API directly over HTTPS so every screen can be a Tími-designed WPF window —
/// no Clerk-hosted or Clerk-branded sign-in surface is ever mounted. See docs/PLATFORM-CONTRACT.md.
/// </summary>
public sealed class ClerkAuthService : IDisposable
{
    private readonly CookieContainer _cookies = new();
    private readonly HttpClient _http;
    private readonly CredentialStore _credentials;
    private string? _frontendApiBase;
    private string? _activeSessionId;
    private string? _workerToken;
    private DateTimeOffset? _workerTokenExpiresAt;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };

    public ClerkAuthService(CredentialStore credentials)
    {
        _credentials = credentials;
        var handler = new HttpClientHandler { CookieContainer = _cookies, UseCookies = true, AllowAutoRedirect = false };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) };
    }

    public bool HasSession => !string.IsNullOrEmpty(_activeSessionId) && !string.IsNullOrEmpty(_workerToken);
    public string? WorkerToken => _workerToken;
    public string? ActiveSessionId => _activeSessionId;
    public string? FrontendApiBase => _frontendApiBase;

    /// <summary>Decodes the Clerk Frontend API host from a publishable key: prefix + base64("&lt;host&gt;$").</summary>
    public static string ResolveFrontendApiHost(string publishableKey)
    {
        string[] prefixes = ["pk_test_", "pk_live_"];
        var prefix = prefixes.FirstOrDefault(p => publishableKey.StartsWith(p, StringComparison.Ordinal))
            ?? throw new InvalidOperationException("Unrecognized Clerk publishable key format.");
        var encoded = publishableKey[prefix.Length..];
        var padded = encoded.Length % 4 == 0 ? encoded : encoded + new string('=', 4 - encoded.Length % 4);
        var decoded = Encoding.UTF8.GetString(Convert.FromBase64String(padded));
        return decoded.TrimEnd('$');
    }

    /// <summary>GET {workerBaseUrl}/api/config, then resolve the Clerk Frontend API host from clerkPublishableKey.</summary>
    public async Task<string> ResolveFrontendApiBaseAsync(string workerBaseUrl, CancellationToken ct)
    {
        var url = new Uri(new Uri(workerBaseUrl.TrimEnd('/') + "/"), "api/config");
        using var response = await _http.GetAsync(url, ct);
        var raw = await response.Content.ReadAsStringAsync(ct);
        response.EnsureSuccessStatusCode();
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;

        string? host = root.TryGetProperty("clerkFrontendApi", out var fapi) && fapi.ValueKind == JsonValueKind.String
            ? fapi.GetString()
            : null;

        if (string.IsNullOrWhiteSpace(host))
        {
            if (!root.TryGetProperty("clerkPublishableKey", out var pk) || pk.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(pk.GetString()))
                throw new InvalidOperationException("The Worker did not return a Clerk publishable key.");
            host = ResolveFrontendApiHost(pk.GetString()!);
        }

        _frontendApiBase = $"https://{host}";
        return _frontendApiBase;
    }

    /// <summary>Attempts to resume a previously persisted Clerk session without any user interaction.</summary>
    public async Task<bool> TryRestoreAsync(string workerBaseUrl, CancellationToken ct)
    {
        var stored = _credentials.Load();
        if (stored is null || string.IsNullOrWhiteSpace(stored.FrontendApiBase) || string.IsNullOrWhiteSpace(stored.ClientCookie) || string.IsNullOrWhiteSpace(stored.ActiveSessionId))
            return false;

        _frontendApiBase = stored.FrontendApiBase;
        SetClientCookie(stored.ClientCookie);
        _activeSessionId = stored.ActiveSessionId;
        _workerToken = stored.WorkerToken;
        _workerTokenExpiresAt = stored.WorkerTokenExpiresAt;

        try
        {
            var client = await GetClientAsync(ct);
            if (!client.Sessions.Any(s => s.Id == _activeSessionId && string.Equals(s.Status, "active", StringComparison.OrdinalIgnoreCase)))
            {
                _activeSessionId = null;
                return false;
            }
            await EnsureFreshTokenAsync(ct);
            return HasSession;
        }
        catch
        {
            return false;
        }
    }

    public async Task<ClerkAuthState> StartSignInAsync(string identifier, CancellationToken ct)
    {
        using var response = await _http.PostAsync(FrontendUri("/v1/client/sign_ins"), Form(("identifier", identifier)), ct);
        var signIn = await ExtractAsync<ClerkSignInResource>(response, ct);
        return TrackSignIn(signIn);
    }

    public async Task<ClerkAuthState> PrepareFirstFactorAsync(string signInId, string strategy, string? emailAddressId, string? phoneNumberId, CancellationToken ct)
    {
        using var response = await _http.PostAsync(
            FrontendUri($"/v1/client/sign_ins/{signInId}/prepare_first_factor"),
            Form(("strategy", strategy), ("email_address_id", emailAddressId), ("phone_number_id", phoneNumberId)), ct);
        var signIn = await ExtractAsync<ClerkSignInResource>(response, ct);
        return TrackSignIn(signIn);
    }

    public async Task<ClerkAuthState> AttemptFirstFactorAsync(string signInId, string strategy, string? code, string? password, CancellationToken ct)
    {
        using var response = await _http.PostAsync(
            FrontendUri($"/v1/client/sign_ins/{signInId}/attempt_first_factor"),
            Form(("strategy", strategy), ("code", code), ("password", password)), ct);
        var signIn = await ExtractAsync<ClerkSignInResource>(response, ct);
        return await CompleteIfNeededAsync(signIn, ct);
    }

    public async Task<ClerkAuthState> ResetPasswordAsync(string signInId, string newPassword, CancellationToken ct)
    {
        using var response = await _http.PostAsync(FrontendUri($"/v1/client/sign_ins/{signInId}/reset_password"), Form(("password", newPassword)), ct);
        var signIn = await ExtractAsync<ClerkSignInResource>(response, ct);
        return await CompleteIfNeededAsync(signIn, ct);
    }

    public async Task<ClerkClientResource> GetClientAsync(CancellationToken ct)
    {
        using var response = await _http.GetAsync(FrontendUri("/v1/client"), ct);
        return await ExtractAsync<ClerkClientResource>(response, ct);
    }

    public async Task<List<ClerkOrganizationMembershipResource>> GetOrganizationMembershipsAsync(CancellationToken ct)
    {
        using var response = await _http.GetAsync(FrontendUri("/v1/me/organization_memberships"), ct);
        var raw = await response.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;
        if (!response.IsSuccessStatusCode) throw new ClerkApiException(ExtractErrorMessage(root), response.StatusCode);

        var node = root.TryGetProperty("response", out var resp) ? resp : root;
        if (node.ValueKind == JsonValueKind.Array) return node.Deserialize<List<ClerkOrganizationMembershipResource>>(JsonOptions) ?? [];
        if (node.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array) return data.Deserialize<List<ClerkOrganizationMembershipResource>>(JsonOptions) ?? [];
        return [];
    }

    /// <summary>Activates an organization on the current session via /touch (never a mounted OrganizationSwitcher).</summary>
    public async Task ActivateOrganizationAsync(string organizationId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_activeSessionId)) throw new InvalidOperationException("Not signed in.");
        using var response = await _http.PostAsync(FrontendUri($"/v1/client/sessions/{_activeSessionId}/touch"), Form(("active_organization_id", organizationId)), ct);
        await ExtractRawAsync(response, ct);
        await MintWorkerTokenAsync(ct);
        PersistState();
    }

    /// <summary>Begins Google/Apple OAuth (and, best-effort, passkey) via the OS browser against a one-shot loopback listener.</summary>
    public async Task<bool> RunRedirectSignInAsync(string strategy, CancellationToken ct)
    {
        var prefix = ReserveLoopbackPrefix();
        using var listener = new HttpListener();
        listener.Prefixes.Add(prefix);
        listener.Start();
        try
        {
            using var response = await _http.PostAsync(FrontendUri("/v1/client/sign_ins"), Form(("strategy", strategy), ("redirect_url", prefix)), ct);
            var signIn = await ExtractAsync<ClerkSignInResource>(response, ct);
            TrackSignIn(signIn);
            var redirectUrl = signIn.ExternalVerificationRedirectUrl;
            if (string.IsNullOrWhiteSpace(redirectUrl))
                throw new InvalidOperationException($"Clerk did not return a browser sign-in link for '{strategy}'. This build cannot complete that method from here.");

            Process.Start(new ProcessStartInfo(redirectUrl) { UseShellExecute = true });

            var contextTask = listener.GetContextAsync();
            var winner = await Task.WhenAny(contextTask, Task.Delay(TimeSpan.FromMinutes(3), ct));
            if (winner != contextTask) throw new TimeoutException("Sign-in was not completed in the browser within 3 minutes.");
            var context = await contextTask;
            await RespondLoopbackAsync(context, ct);

            return await CompleteAfterRedirectAsync(ct);
        }
        finally
        {
            listener.Stop();
        }
    }

    public async Task EnsureFreshTokenAsync(CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_activeSessionId)) throw new InvalidOperationException("Not signed in.");
        if (_workerToken is null || _workerTokenExpiresAt is null || _workerTokenExpiresAt.Value <= DateTimeOffset.UtcNow.AddSeconds(10))
        {
            await MintWorkerTokenAsync(ct);
            PersistState();
        }
    }

    public async Task ForceRefreshAsync(CancellationToken ct)
    {
        await MintWorkerTokenAsync(ct);
        PersistState();
    }

    public async Task SignOutAsync(CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(_activeSessionId) && _frontendApiBase is not null)
        {
            // Clerk's Frontend API exposes no DELETE on a session; ending one is
            // POST .../end. Best effort either way: the local credential wipe
            // below is what actually signs this machine out.
            try { using var response = await _http.PostAsync(FrontendUri($"/v1/client/sessions/{_activeSessionId}/end"), Form(), ct); }
            catch { /* best effort */ }
        }
        _activeSessionId = null;
        _workerToken = null;
        _workerTokenExpiresAt = null;
        _credentials.Clear();
    }

    // ---- internals -----------------------------------------------------

    private async Task<bool> CompleteAfterRedirectAsync(CancellationToken ct)
    {
        var client = await GetClientAsync(ct);
        var sessionId = client.LastActiveSessionId ?? client.Sessions.FirstOrDefault(s => string.Equals(s.Status, "active", StringComparison.OrdinalIgnoreCase))?.Id;
        if (string.IsNullOrEmpty(sessionId)) return false;
        _activeSessionId = sessionId;
        await MintWorkerTokenAsync(ct);
        PersistState();
        return true;
    }

    private static async Task RespondLoopbackAsync(HttpListenerContext context, CancellationToken ct)
    {
        const string html = "<html><body style=\"font-family:'Segoe UI',sans-serif;background:#F3F5FA;color:#111B3B;padding:48px;text-align:center\">" +
            "<h2 style=\"font-family:Georgia,serif\">Tími Vet sign-in complete</h2>" +
            "<p>You can close this window and return to Tími Vet.</p></body></html>";
        var buffer = Encoding.UTF8.GetBytes(html);
        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.ContentLength64 = buffer.Length;
        await context.Response.OutputStream.WriteAsync(buffer, ct);
        context.Response.OutputStream.Close();
    }

    private static string ReserveLoopbackPrefix()
    {
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        return $"http://127.0.0.1:{port}/timivet-callback/";
    }

    private async Task<ClerkAuthState> CompleteIfNeededAsync(ClerkSignInResource signIn, CancellationToken ct)
    {
        var state = TrackSignIn(signIn);
        if (signIn.Status == ClerkSignInStatus.Complete && !string.IsNullOrEmpty(signIn.CreatedSessionId))
        {
            _activeSessionId = signIn.CreatedSessionId;
            await MintWorkerTokenAsync(ct);
            PersistState();
        }
        return state;
    }

    private static ClerkAuthState TrackSignIn(ClerkSignInResource signIn)
    {
        return new ClerkAuthState
        {
            SignInId = signIn.Id,
            Status = signIn.Status ?? "",
            SupportedFirstFactors = signIn.SupportedFirstFactors ?? [],
            SessionId = signIn.CreatedSessionId
        };
    }

    private async Task MintWorkerTokenAsync(CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_activeSessionId)) throw new InvalidOperationException("No active Clerk session.");
        var token = await TryMintTemplateAsync("timinow", ct) ?? await TryMintTemplateAsync(null, ct)
            ?? throw new InvalidOperationException("Clerk did not return a session token for this Worker.");
        _workerToken = token.Jwt;
        _workerTokenExpiresAt = ParseJwtExpiry(token.Jwt) ?? DateTimeOffset.UtcNow.AddMinutes(1);
    }

    private async Task<ClerkTokenResource?> TryMintTemplateAsync(string? template, CancellationToken ct)
    {
        var path = template is null ? $"/v1/client/sessions/{_activeSessionId}/tokens" : $"/v1/client/sessions/{_activeSessionId}/tokens/{template}";
        using var response = await _http.PostAsync(FrontendUri(path), new FormUrlEncodedContent([]), ct);
        if (!response.IsSuccessStatusCode) return null;
        var raw = await response.Content.ReadAsStringAsync(ct);
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            var node = root.TryGetProperty("jwt", out _) ? root : (root.TryGetProperty("response", out var resp) ? resp : root);
            return node.Deserialize<ClerkTokenResource>(JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    private static DateTimeOffset? ParseJwtExpiry(string jwt)
    {
        var parts = jwt.Split('.');
        if (parts.Length < 2) return null;
        try
        {
            var payload = Base64UrlDecode(parts[1]);
            using var doc = JsonDocument.Parse(payload);
            if (doc.RootElement.TryGetProperty("exp", out var exp) && exp.TryGetInt64(out var seconds))
                return DateTimeOffset.FromUnixTimeSeconds(seconds);
        }
        catch { /* fall through */ }
        return null;
    }

    private static byte[] Base64UrlDecode(string input)
    {
        var value = input.Replace('-', '+').Replace('_', '/');
        value += (value.Length % 4) switch { 2 => "==", 3 => "=", _ => "" };
        return Convert.FromBase64String(value);
    }

    private void PersistState()
    {
        var cookie = ExtractClientCookie();
        if (_frontendApiBase is null || cookie is null) return;
        _credentials.Save(new StoredCredential
        {
            FrontendApiBase = _frontendApiBase,
            ClientCookie = cookie,
            ActiveSessionId = _activeSessionId,
            WorkerToken = _workerToken,
            WorkerTokenExpiresAt = _workerTokenExpiresAt
        });
    }

    private string? ExtractClientCookie()
    {
        if (_frontendApiBase is null) return null;
        var uri = new Uri(_frontendApiBase);
        foreach (Cookie cookie in _cookies.GetCookies(uri))
            if (cookie.Name == "__client") return cookie.Value;
        return null;
    }

    private void SetClientCookie(string value)
    {
        if (_frontendApiBase is null || string.IsNullOrEmpty(value)) return;
        var uri = new Uri(_frontendApiBase);
        _cookies.Add(uri, new Cookie("__client", value, "/", uri.Host));
    }

    private Uri FrontendUri(string path)
    {
        if (_frontendApiBase is null) throw new InvalidOperationException("Clerk frontend API host has not been resolved yet.");
        var separator = path.Contains('?') ? "&" : "?";
        return new Uri($"{_frontendApiBase}{path}{separator}_clerk_js_version=5");
    }

    private static FormUrlEncodedContent Form(params (string Key, string? Value)[] fields)
        => new(fields.Where(f => f.Value is not null).Select(f => new KeyValuePair<string, string>(f.Key, f.Value!)));

    private static async Task<T> ExtractAsync<T>(HttpResponseMessage http, CancellationToken ct)
    {
        var raw = await http.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;
        if (!http.IsSuccessStatusCode) throw new ClerkApiException(ExtractErrorMessage(root), http.StatusCode);
        var node = root.TryGetProperty("response", out var resp) ? resp : root;
        return node.Deserialize<T>(JsonOptions) ?? throw new InvalidOperationException("Clerk returned an empty response.");
    }

    private static async Task ExtractRawAsync(HttpResponseMessage http, CancellationToken ct)
    {
        var raw = await http.Content.ReadAsStringAsync(ct);
        if (http.IsSuccessStatusCode) return;
        using var doc = JsonDocument.Parse(raw);
        throw new ClerkApiException(ExtractErrorMessage(doc.RootElement), http.StatusCode);
    }

    private static string ExtractErrorMessage(JsonElement root)
    {
        if (root.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
        {
            var first = errors[0];
            if (first.TryGetProperty("long_message", out var lm) && lm.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(lm.GetString()))
                return lm.GetString()!;
            if (first.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(m.GetString()))
                return m.GetString()!;
        }
        return "Clerk sign-in failed.";
    }

    public void Dispose() => _http.Dispose();
}
