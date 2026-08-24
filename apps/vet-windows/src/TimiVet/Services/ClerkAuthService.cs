using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Text.Json;
using System.Text.Json.Serialization;
using TimiVet.Models;

namespace TimiVet.Services;

public static class ClerkSignInStatus
{
    public const string Complete = "complete";
    public const string NeedsFirstFactor = "needs_first_factor";
    public const string NeedsSecondFactor = "needs_second_factor";
}

public sealed class ClerkApiException(string message, HttpStatusCode statusCode) : Exception(message)
{
    public HttpStatusCode StatusCode { get; } = statusCode;

    /// <summary>
    /// Whether Clerk refused the credential, as distinct from not being reachable.
    ///
    /// This distinction is the whole point of the restore path. A 401, a 403 or a 404 on
    /// <c>/v1/client</c> means the client Tími is presenting no longer exists, which is a real sign-out.
    /// A timeout, a DNS failure or a 502 says nothing whatsoever about the account — a clinic PC that
    /// finishes booting before its Wi-Fi associates produces one every single morning.
    /// </summary>
    public bool IsCredentialRejected =>
        StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden or HttpStatusCode.NotFound;
}

/// <summary>What a launch-time session restore was actually able to establish.</summary>
public enum SessionRestoreOutcome
{
    /// <summary>Nothing worth resuming is on disk. Sign in.</summary>
    NoCredential,

    /// <summary>Clerk confirmed the stored session and a fresh Worker token is in hand.</summary>
    Restored,

    /// <summary>
    /// Clerk could not be reached, but the stored credential and a Worker token are both present, so the
    /// console carries on and reconnects in the background rather than throwing the clinic back to a
    /// sign-in screen it has no way to complete either.
    /// </summary>
    ResumedUnverified,

    /// <summary>Clerk could not be reached and there is no usable token. The credential is kept.</summary>
    Unreachable,

    /// <summary>Clerk refused the credential. It has been erased and sign-in must start over.</summary>
    Rejected
}

public sealed class ClerkFirstFactor
{
    public string Strategy { get; set; } = "";
    [JsonPropertyName("email_address_id")] public string? EmailAddressId { get; set; }
    [JsonPropertyName("phone_number_id")] public string? PhoneNumberId { get; set; }
    [JsonPropertyName("safe_identifier")] public string? SafeIdentifier { get; set; }
    public bool Primary { get; set; }
}

public sealed class ClerkSignInResource
{
    public string? Id { get; set; }
    public string? Status { get; set; }
    [JsonPropertyName("supported_first_factors")] public List<ClerkFirstFactor>? SupportedFirstFactors { get; set; }
    [JsonPropertyName("created_session_id")] public string? CreatedSessionId { get; set; }
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
///
/// Requests go out in Clerk's <b>native</b> mode (<c>_is_native=true</c>, the client JWT carried in the
/// <c>Authorization</c> header) rather than the browser mode this client used to imitate. That is not a
/// preference. A signed desktop application is not a browser, cannot render Clerk's Turnstile challenge,
/// and cannot satisfy the bot protection that guards the browser endpoints; native mode is the path Clerk
/// means a client like this one to use. If the instance has the Native API switched off it says so, once,
/// and this falls back to the cookie path for the rest of the launch.
/// </summary>
public sealed class ClerkAuthService : IDisposable
{
    private readonly CookieContainer _cookies = new();

    /// <summary>
    /// Two clients, because native mode and cookie mode are not a mix.
    ///
    /// Clerk refuses a request that carries both an <c>Authorization</c> header and browser cookies, and
    /// <see cref="HttpClientHandler.UseCookies"/> is fixed at construction — there is no per-request
    /// equivalent of URLSession's <c>httpShouldHandleCookies</c>. Sending native requests through a client
    /// with a cookie jar means the <c>__client</c> cookie Clerk sets on the way past is replayed on the
    /// next call alongside the header, and the whole flow is rejected for reasons that read like a Clerk
    /// outage.
    /// </summary>
    private readonly HttpClient _nativeHttp;
    private readonly HttpClient _webHttp;

    private readonly CredentialStore _credentials;
    private string? _frontendApiBase;
    private string? _activeSessionId;
    private string? _workerToken;
    private DateTimeOffset? _workerTokenExpiresAt;

    /// <summary>Clerk's native client JWT — the native equivalent of a browser's <c>__client</c> cookie.</summary>
    private string? _deviceToken;

    /// <summary>Native Frontend API mode. Flipped off for the rest of the launch on <c>native_api_disabled</c>.</summary>
    private bool _nativeMode = true;

    private DateTimeOffset? _clinicSurfaceVerifiedAt;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = true };

    /// <summary>
    /// How long a previously-verified clinic session may be resumed into the console without Clerk being
    /// reachable to re-check it. Long enough to cover an outage, a holiday weekend, or a laptop left shut;
    /// short enough that somebody removed from a workspace stops getting in.
    /// </summary>
    private static readonly TimeSpan OfflineResumeWindow = TimeSpan.FromDays(30);

    public ClerkAuthService(CredentialStore credentials)
    {
        _credentials = credentials;
        _nativeHttp = new HttpClient(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(20)
        };
        _webHttp = new HttpClient(new HttpClientHandler { CookieContainer = _cookies, UseCookies = true, AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(20)
        };
    }

    public bool HasSession => !string.IsNullOrEmpty(_activeSessionId) && !string.IsNullOrEmpty(_workerToken);
    public string? WorkerToken => _workerToken;
    public string? ActiveSessionId => _activeSessionId;
    public string? FrontendApiBase => _frontendApiBase;
    public bool IsNativeMode => _nativeMode;

    /// <summary>Decodes the Clerk Frontend API host from a publishable key: prefix + base64("&lt;host&gt;$").</summary>
    public static string ResolveFrontendApiHost(string publishableKey)
    {
        string[] prefixes = ["pk_test_", "pk_live_"];
        var prefix = prefixes.FirstOrDefault(p => publishableKey.StartsWith(p, StringComparison.Ordinal))
            ?? throw new InvalidOperationException($"That Clerk publishable key is in a format Tími does not recognize ({Preview(publishableKey)}). It should start with pk_live_ or pk_test_.");
        var encoded = publishableKey[prefix.Length..];
        var padded = encoded.Length % 4 == 0 ? encoded : encoded + new string('=', 4 - encoded.Length % 4);
        string decoded;
        try { decoded = Encoding.UTF8.GetString(Convert.FromBase64String(padded)); }
        catch (FormatException) { throw new InvalidOperationException($"Tími could not read the Clerk publishable key the Worker returned ({Preview(publishableKey)})."); }
        var host = decoded.TrimEnd('$');
        if (string.IsNullOrWhiteSpace(host)) throw new InvalidOperationException("The Clerk publishable key decodes to an empty sign-in host.");
        return host;
    }

    private static string Preview(string value) => value.Length <= 12 ? value : value[..12] + "…";

    /// <summary>
    /// Points this service at the Clerk instance the Worker named, from an already-fetched /api/config.
    ///
    /// The config request deliberately belongs to <see cref="ClinicApiClient"/> rather than to a private
    /// HttpClient in here: it is the one Worker call that must work with no session at all, and giving it
    /// its own back door is how the client came to demand a token for every other unauthenticated request
    /// without anybody noticing that it had locked sign-in out of itself.
    ///
    /// Every failure below used to arrive as the same sentence — "Tími could not reach Clerk. Check the
    /// Worker connection in Settings." — which points at the network no matter which of them happened.
    /// </summary>
    public string UseFrontendApi(AppConfig config, string address)
    {
        string host;
        if (!string.IsNullOrWhiteSpace(config.ClerkFrontendApi))
        {
            host = config.ClerkFrontendApi.Trim();
        }
        else if (!string.IsNullOrWhiteSpace(config.ClerkPublishableKey))
        {
            host = ResolveFrontendApiHost(config.ClerkPublishableKey.Trim());
        }
        else
        {
            throw new InvalidOperationException($"{address} is reachable but serves no Clerk publishable key, so there is no sign-in service to reach. Deploy the Workers with CLERK_PUBLISHABLE_KEY set.");
        }
        var resolved = $"https://{host}";
        _frontendApiBase = resolved;
        return resolved;
    }

    /// <summary>
    /// Attempts to resume a previously persisted Clerk session with no user interaction.
    ///
    /// The old shape of this method was <c>try { … } catch { return false; }</c>, and a false answer sent
    /// the operator to the sign-in window. That treats "Clerk says this session is gone" and "the network
    /// was not up yet when the console launched" as the same event, and the second one happens on a clinic
    /// PC most mornings. Only <see cref="ClerkApiException.IsCredentialRejected"/> erases anything now.
    /// </summary>
    public async Task<SessionRestoreOutcome> RestoreAsync(CancellationToken ct)
    {
        var stored = _credentials.Load();
        if (stored is null || string.IsNullOrWhiteSpace(stored.FrontendApiBase) || string.IsNullOrWhiteSpace(stored.ActiveSessionId))
            return SessionRestoreOutcome.NoCredential;
        if (string.IsNullOrWhiteSpace(stored.ClerkDeviceToken) && string.IsNullOrWhiteSpace(stored.ClientCookie))
            return SessionRestoreOutcome.NoCredential;

        _frontendApiBase = stored.FrontendApiBase;
        _activeSessionId = stored.ActiveSessionId;
        _workerToken = stored.WorkerToken;
        _workerTokenExpiresAt = stored.WorkerTokenExpiresAt;
        _clinicSurfaceVerifiedAt = stored.ClinicSurfaceVerifiedAt;

        if (!string.IsNullOrWhiteSpace(stored.ClerkDeviceToken))
        {
            _deviceToken = stored.ClerkDeviceToken;
        }
        else
        {
            // Written before native mode existed. Resume it the way it was written: a native /v1/client
            // carrying no device token is handed a brand-new empty client, which reads as a sign-out for
            // no reason at all. SignOutLocally puts native mode back for the next sign-in.
            _nativeMode = false;
            SetClientCookie(stored.ClientCookie);
        }

        try
        {
            var client = await GetClientAsync(ct);
            var stillActive = client.Sessions.Any(s => s.Id == _activeSessionId && string.Equals(s.Status, "active", StringComparison.OrdinalIgnoreCase));
            if (!stillActive)
            {
                // Clerk answered, and the answer is that this session is over. That is a real sign-out.
                SignOutLocally();
                return SessionRestoreOutcome.Rejected;
            }
            await EnsureFreshTokenAsync(ct);
            PersistState();
            return HasSession ? SessionRestoreOutcome.Restored : ResumeWithoutChecking();
        }
        catch (ClerkApiException ex) when (ex.IsCredentialRejected)
        {
            SignOutLocally();
            return SessionRestoreOutcome.Rejected;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return ResumeWithoutChecking();
        }
    }

    /// <summary>
    /// Stay signed in when the check could not be made. Nothing is deleted here, deliberately: the
    /// credential on disk is still the best evidence available about who is using this machine.
    /// </summary>
    private SessionRestoreOutcome ResumeWithoutChecking() =>
        HasSession ? SessionRestoreOutcome.ResumedUnverified : SessionRestoreOutcome.Unreachable;

    /// <summary>
    /// Whether a session may be carried into the console without Clerk having confirmed it this launch.
    /// True only for a credential that has already passed a clinic-surface check, and recently — resuming
    /// is for an outage, not a way past the check for an account that never had access.
    /// </summary>
    public bool CanResumeClinicSessionOffline =>
        HasSession && _clinicSurfaceVerifiedAt is { } verifiedAt && DateTimeOffset.UtcNow - verifiedAt < OfflineResumeWindow;

    /// <summary>Records that /api/session confirmed clinic access, so a later offline launch may resume.</summary>
    public void RecordClinicSurfaceVerified()
    {
        _clinicSurfaceVerifiedAt = DateTimeOffset.UtcNow;
        PersistState();
    }

    public async Task<ClerkAuthState> StartSignInAsync(string identifier, CancellationToken ct)
    {
        var response = await ClerkRequestAsync(HttpMethod.Post, "/v1/client/sign_ins", [("identifier", NormalizeIdentifier(identifier))], ct);
        return TrackSignIn(Extract<ClerkSignInResource>(response));
    }

    public async Task<ClerkAuthState> PrepareFirstFactorAsync(string signInId, string strategy, string? emailAddressId, string? phoneNumberId, CancellationToken ct)
    {
        var response = await ClerkRequestAsync(HttpMethod.Post, $"/v1/client/sign_ins/{signInId}/prepare_first_factor",
            [("strategy", strategy), ("email_address_id", emailAddressId), ("phone_number_id", phoneNumberId)], ct);
        return TrackSignIn(Extract<ClerkSignInResource>(response));
    }

    /// <summary>
    /// Verifies a one-time code. Codes are the only first factor this console attempts — the password
    /// and OAuth strategies were removed on the owner's instruction that every sign-in surface offers
    /// email and phone codes only.
    /// </summary>
    public async Task<ClerkAuthState> AttemptFirstFactorAsync(string signInId, string strategy, string code, CancellationToken ct)
    {
        var response = await ClerkRequestAsync(HttpMethod.Post, $"/v1/client/sign_ins/{signInId}/attempt_first_factor",
            [("strategy", strategy), ("code", code)], ct);
        return await CompleteIfNeededAsync(Extract<ClerkSignInResource>(response), ct);
    }

    public async Task<ClerkClientResource> GetClientAsync(CancellationToken ct)
    {
        var response = await ClerkRequestAsync(HttpMethod.Get, "/v1/client", null, ct);
        return Extract<ClerkClientResource>(response);
    }

    public async Task<List<ClerkOrganizationMembershipResource>> GetOrganizationMembershipsAsync(CancellationToken ct)
    {
        var response = await ClerkRequestAsync(HttpMethod.Get, "/v1/me/organization_memberships", null, ct);
        using var doc = ParseBody(response);
        var root = doc.RootElement;
        if (!response.IsSuccess) throw new ClerkApiException(ExtractErrorMessage(root), response.StatusCode);

        var node = root.TryGetProperty("response", out var resp) ? resp : root;
        if (node.ValueKind == JsonValueKind.Array) return node.Deserialize<List<ClerkOrganizationMembershipResource>>(JsonOptions) ?? [];
        if (node.ValueKind == JsonValueKind.Object && node.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array)
            return data.Deserialize<List<ClerkOrganizationMembershipResource>>(JsonOptions) ?? [];
        return [];
    }

    /// <summary>Activates an organization on the current session via /touch (never a mounted OrganizationSwitcher).</summary>
    public async Task ActivateOrganizationAsync(string organizationId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_activeSessionId)) throw new InvalidOperationException("Not signed in.");
        var response = await ClerkRequestAsync(HttpMethod.Post, $"/v1/client/sessions/{_activeSessionId}/touch", [("active_organization_id", organizationId)], ct);
        if (!response.IsSuccess)
        {
            using var doc = ParseBody(response);
            throw new ClerkApiException(ExtractErrorMessage(doc.RootElement), response.StatusCode);
        }
        await MintWorkerTokenAsync(ct);
        PersistState();
    }

    /// <summary>
    /// Returns a Worker token that is good right now, minting a new one when the current one is missing or
    /// within ten seconds of expiring. A Clerk session token lives about a minute, so "we minted one at
    /// sign-in" is worth nothing by the time anybody answers their second request of the shift.
    /// </summary>
    public async Task EnsureFreshTokenAsync(CancellationToken ct)
    {
        if (string.IsNullOrEmpty(_activeSessionId)) throw new InvalidOperationException("Not signed in.");
        if (_workerToken is null || _workerTokenExpiresAt is null || _workerTokenExpiresAt.Value <= DateTimeOffset.UtcNow.AddSeconds(10))
        {
            await MintWorkerTokenAsync(ct);
            PersistState();
        }
    }

    /// <summary>
    /// Unconditionally mints a new token. Used once after a 401 — the point is to replace the credential
    /// rather than replay the dead one, so this must not consult the expiry it clearly got wrong.
    /// </summary>
    public async Task ForceRefreshAsync(CancellationToken ct)
    {
        await MintWorkerTokenAsync(ct);
        PersistState();
    }

    public async Task SignOutAsync(CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(_activeSessionId) && _frontendApiBase is not null)
        {
            // Clerk's Frontend API exposes no DELETE on a session; ending one is POST .../end. Best effort
            // either way: the local credential wipe below is what actually signs this machine out.
            try { await ClerkRequestAsync(HttpMethod.Post, $"/v1/client/sessions/{_activeSessionId}/end", [], ct); }
            catch { /* best effort */ }
        }
        SignOutLocally();
    }

    /// <summary>
    /// Erases everything about this machine's session, including the DPAPI file. Called only when Clerk
    /// has refused the credential or the operator asked to sign out — never from a catch-all.
    /// </summary>
    private void SignOutLocally()
    {
        _activeSessionId = null;
        _workerToken = null;
        _workerTokenExpiresAt = null;
        _deviceToken = null;
        _clinicSurfaceVerifiedAt = null;
        _nativeMode = true;
        _credentials.Clear();
    }

    // ---- internals -----------------------------------------------------

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

        // The `timinow` JWT template is what the Worker verifies; the untemplated endpoint is the fallback
        // for an instance where it has not been created yet.
        var templated = await TryMintTemplateAsync("timinow", ct);
        var token = templated.Token;
        var status = templated.Status;
        if (token is null)
        {
            var plain = await TryMintTemplateAsync(null, ct);
            token = plain.Token;
            status = plain.Status;
        }

        // Which failure this was matters enormously one frame later: RestoreAsync treats a 401/403/404 as
        // a sign-out and everything else as weather. Throwing a bare InvalidOperationException here made
        // every minting failure look like weather, including a revoked session.
        if (token is null) throw new ClerkApiException("Clerk did not return a session token for this Worker.", status);

        _workerToken = token.Jwt;
        _workerTokenExpiresAt = ParseJwtExpiry(token.Jwt) ?? DateTimeOffset.UtcNow.AddMinutes(1);
    }

    private async Task<(ClerkTokenResource? Token, HttpStatusCode Status)> TryMintTemplateAsync(string? template, CancellationToken ct)
    {
        var path = template is null ? $"/v1/client/sessions/{_activeSessionId}/tokens" : $"/v1/client/sessions/{_activeSessionId}/tokens/{template}";
        var response = await ClerkRequestAsync(HttpMethod.Post, path, [], ct);
        if (!response.IsSuccess) return (null, response.StatusCode);
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(response.Body) ? "{}" : response.Body);
            var root = doc.RootElement;
            var node = root.TryGetProperty("jwt", out _) ? root : (root.TryGetProperty("response", out var resp) ? resp : root);
            var parsed = node.Deserialize<ClerkTokenResource>(JsonOptions);
            return (string.IsNullOrEmpty(parsed?.Jwt) ? null : parsed, response.StatusCode);
        }
        catch (JsonException)
        {
            return (null, response.StatusCode);
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
        var frontendApiBase = _frontendApiBase;
        if (frontendApiBase is null) return;
        var cookie = _nativeMode ? null : ExtractClientCookie();
        // A blob with a host and a session id but no credential is worse than no blob at all: the next
        // launch restores something it can never renew, and the failure surfaces as an unexplained
        // sign-out rather than as an ordinary "please sign in".
        if (string.IsNullOrEmpty(_deviceToken) && string.IsNullOrEmpty(cookie)) return;

        _credentials.Save(new StoredCredential
        {
            FrontendApiBase = frontendApiBase,
            ClientCookie = cookie ?? "",
            ClerkDeviceToken = _deviceToken,
            ActiveSessionId = _activeSessionId,
            WorkerToken = _workerToken,
            WorkerTokenExpiresAt = _workerTokenExpiresAt,
            ClinicSurfaceVerifiedAt = _clinicSurfaceVerifiedAt
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

    // ---- Clerk Frontend API transport ----------------------------------

    private readonly record struct ClerkResponse(HttpStatusCode StatusCode, string Body)
    {
        public bool IsSuccess => (int)StatusCode is >= 200 and < 300;
    }

    /// <summary>
    /// One Clerk Frontend API call, with a single fallback out of native mode.
    ///
    /// The retry is safe because <c>native_api_disabled</c> is refused by Clerk before it touches any
    /// state: the sign-in was not started, the code was not sent, nothing is duplicated by asking again
    /// the browser way. Form fields rather than an <see cref="HttpContent"/> are taken for exactly that
    /// reason — a content body cannot be sent twice.
    /// </summary>
    private async Task<ClerkResponse> ClerkRequestAsync(HttpMethod method, string path, (string Key, string? Value)[]? form, CancellationToken ct)
    {
        var response = await PerformClerkRequestAsync(method, path, form, ct);
        if (!response.IsSuccess && _nativeMode && ExtractErrorCode(response.Body).Contains("native_api_disabled", StringComparison.OrdinalIgnoreCase))
        {
            _nativeMode = false;
            _deviceToken = null;
            response = await PerformClerkRequestAsync(method, path, form, ct);
        }
        return response;
    }

    private async Task<ClerkResponse> PerformClerkRequestAsync(HttpMethod method, string path, (string Key, string? Value)[]? form, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, FrontendUri(path));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        // The client JWT goes in the header verbatim — Clerk issues it with whatever scheme it wants and
        // expects it echoed unchanged, so this is not an AuthenticationHeaderValue.
        if (_nativeMode && !string.IsNullOrEmpty(_deviceToken))
            request.Headers.TryAddWithoutValidation("Authorization", _deviceToken);

        if (form is not null) request.Content = Form(form);

        var client = _nativeMode ? _nativeHttp : _webHttp;
        using var response = await client.SendAsync(request, ct);

        // Before the status check, not after. Clerk issues the client JWT on failure responses too, and
        // several ordinary steps of this flow run straight through one — an unknown identifier answers
        // 422 — so absorbing it only on success leaves the next request unauthenticated for no reason
        // anyone could see from the outside.
        if (_nativeMode) AbsorbDeviceToken(response);

        var body = await response.Content.ReadAsStringAsync(ct);
        return new ClerkResponse(response.StatusCode, body);
    }

    /// <summary>
    /// An absent header means "unchanged"; an empty one, or a bare "Bearer", means Clerk dropped the
    /// client and this machine must drop it too rather than keep replaying a dead identity.
    /// </summary>
    private void AbsorbDeviceToken(HttpResponseMessage response)
    {
        if (!response.Headers.TryGetValues("Authorization", out var values)) return;
        var header = values.FirstOrDefault()?.Trim() ?? "";
        _deviceToken = header.Length == 0 || header.Equals("bearer", StringComparison.OrdinalIgnoreCase) ? null : header;
    }

    private Uri FrontendUri(string path)
    {
        if (_frontendApiBase is null) throw new InvalidOperationException("Clerk frontend API host has not been resolved yet.");
        var separator = path.Contains('?') ? "&" : "?";
        // `_clerk_js_version=5` is what the web surfaces send and is only used on the fallback path.
        var mode = _nativeMode ? "_is_native=true" : "_clerk_js_version=5";
        return new Uri($"{_frontendApiBase}{path}{separator}{mode}");
    }

    private static FormUrlEncodedContent Form(params (string Key, string? Value)[] fields)
        => new(fields.Where(f => f.Value is not null).Select(f => new KeyValuePair<string, string>(f.Key, f.Value!)));

    private static JsonDocument ParseBody(ClerkResponse response)
    {
        try { return JsonDocument.Parse(string.IsNullOrWhiteSpace(response.Body) ? "{}" : response.Body); }
        catch (JsonException)
        {
            // A proxy or captive portal answering with HTML is not Clerk speaking. Say so with the status
            // rather than letting a JsonException reach the sign-in window as its own error text.
            throw new ClerkApiException(
                response.IsSuccess
                    ? "Clerk returned a response Tími could not read."
                    : $"Clerk sign-in failed ({(int)response.StatusCode}).",
                response.StatusCode);
        }
    }

    private static T Extract<T>(ClerkResponse response)
    {
        using var doc = ParseBody(response);
        var root = doc.RootElement;
        if (!response.IsSuccess) throw new ClerkApiException(ExtractErrorMessage(root), response.StatusCode);
        var node = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("response", out var resp) ? resp : root;
        return node.Deserialize<T>(JsonOptions) ?? throw new ClerkApiException("Clerk returned an empty response.", response.StatusCode);
    }

    private static string ExtractErrorCode(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return "";
            if (!root.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array || errors.GetArrayLength() == 0) return "";
            return errors[0].TryGetProperty("code", out var code) && code.ValueKind == JsonValueKind.String ? code.GetString() ?? "" : "";
        }
        catch (JsonException)
        {
            return "";
        }
    }

    private static string ExtractErrorMessage(JsonElement root)
    {
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
        {
            var first = errors[0];
            if (first.TryGetProperty("long_message", out var lm) && lm.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(lm.GetString()))
                return lm.GetString()!;
            if (first.TryGetProperty("message", out var m) && m.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(m.GetString()))
                return m.GetString()!;
        }
        return "Clerk sign-in failed.";
    }

    /// <summary>
    /// Clerk wants a phone number in E.164. Typed the way anybody says it — "5105550126", "(510)
    /// 555-0126" — it is refused as not a valid phone number, and the message describes a format instead
    /// of the fix. Email addresses, usernames, and numbers already written with a country code pass
    /// straight through untouched.
    /// </summary>
    private static string NormalizeIdentifier(string raw)
    {
        var trimmed = raw.Trim();
        if (trimmed.Contains('@')) return trimmed;
        const string punctuation = "+()-. ";
        if (!trimmed.All(c => char.IsDigit(c) || punctuation.Contains(c))) return trimmed;
        var digits = new string(trimmed.Where(char.IsDigit).ToArray());
        if (digits.Length == 0) return trimmed;
        if (trimmed.StartsWith('+')) return "+" + digits;
        if (digits.Length == 10) return "+1" + digits;
        if (digits.Length == 11 && digits.StartsWith('1')) return "+" + digits;
        return trimmed;
    }

    public void Dispose()
    {
        _nativeHttp.Dispose();
        _webHttp.Dispose();
    }
}
