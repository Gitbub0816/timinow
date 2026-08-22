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
        try { return File.Exists(FilePath) ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(FilePath), Json) ?? new() : new(); }
        catch { return new(); }
    }

    public void Save(AppSettings settings)
    {
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

    private static void SetStartup(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
        if (key is null) return;
        if (enabled) key.SetValue("TimiVet", $"\"{Environment.ProcessPath}\""); else key.DeleteValue("TimiVet", throwOnMissingValue: false);
    }
}
