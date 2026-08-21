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

    private static void SetStartup(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
        if (key is null) return;
        if (enabled) key.SetValue("TimiVet", $"\"{Environment.ProcessPath}\""); else key.DeleteValue("TimiVet", throwOnMissingValue: false);
    }
}
