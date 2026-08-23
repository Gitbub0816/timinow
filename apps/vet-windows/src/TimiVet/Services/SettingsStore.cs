using System.IO;
using System.Text.Json;
using Microsoft.Win32;
using TimiVet.Models;

namespace TimiVet.Services;

public sealed class SettingsStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly string _directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClearKey", "TimiVet");
    private string FilePath => Path.Combine(_directory, "settings.json");

    public AppSettings Load()
    {
        AppSettings settings;
        try { settings = (File.Exists(FilePath) ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), Json) : null) ?? new(); }
        catch { settings = new(); }
        return Normalize(settings);
    }

    /// <summary>
    /// Puts the production Worker back whenever the stored address is blank.
    ///
    /// <see cref="AppSettings.ApiBaseUrl"/> defaults to it, and for a genuinely fresh machine that is
    /// enough. It is not enough for an upgrade: every settings.json this app has ever written carries
    /// <c>"ApiBaseUrl": ""</c> unless somebody typed one in, and deserialization assigns that blank
    /// straight over the initializer. The result looked exactly like a fresh install that had ignored its
    /// own default — the console reported that it could not read "/api/config" with nothing in front of
    /// the path, which reads as a Worker or a Clerk fault and is neither.
    ///
    /// A deliberately-chosen address is never touched; only an empty one, which cannot have been chosen.
    /// The polling interval is clamped here too, because a zero read from an older or hand-edited file
    /// turns the poll loop into a spin.
    /// </summary>
    private static AppSettings Normalize(AppSettings settings)
    {
        if (string.IsNullOrWhiteSpace(settings.ApiBaseUrl)) settings.ApiBaseUrl = TimiVetEnvironment.DefaultApiBaseUrl;
        settings.ApiBaseUrl = settings.ApiBaseUrl.Trim();
        settings.PollSeconds = Math.Clamp(settings.PollSeconds, 3, 60);
        return settings;
    }

    public void Save(AppSettings settings)
    {
        Normalize(settings);
        Directory.CreateDirectory(_directory);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(settings, Json));
        SetStartup(settings.StartWithWindows);
    }

    /// <summary>
    /// One-time migration support: the old settings.json wrote a "BearerToken" field in plaintext.
    /// AppSettings no longer declares that property, so it is silently dropped the next time Save() runs.
    /// This reads the raw legacy value (if any) so it can be archived in the DPAPI-protected credential
    /// store instead of simply discarded, then rewrites the file immediately so the plaintext value does
    /// not linger on disk until the next explicit save.
    /// </summary>
    public string? ExtractAndScrubLegacyBearerToken()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var raw = File.ReadAllText(FilePath);
            using var doc = JsonDocument.Parse(raw);
            if (!doc.RootElement.TryGetProperty("BearerToken", out var tokenElement) || tokenElement.ValueKind != JsonValueKind.String)
                return null;

            var legacyToken = tokenElement.GetString();
            // Re-save through the current AppSettings shape (which has no BearerToken property) so the
            // plaintext field is removed from disk immediately, independent of the user hitting Save.
            var settings = Load();
            File.WriteAllText(FilePath, JsonSerializer.Serialize(settings, Json));
            return string.IsNullOrWhiteSpace(legacyToken) ? null : legacyToken;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Best effort, and deliberately so. The Run key can be locked down by policy on a managed clinic
    /// machine; an UnauthorizedAccessException raised here used to take the whole Save with it, so a
    /// checkbox nobody could honour cost the operator the Worker address they had just typed.
    /// </summary>
    private static void SetStartup(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
            if (key is null) return;
            if (enabled) key.SetValue("TimiVet", $"\"{Environment.ProcessPath}\""); else key.DeleteValue("TimiVet", throwOnMissingValue: false);
        }
        catch { /* the console still runs; it just will not start itself */ }
    }
}
