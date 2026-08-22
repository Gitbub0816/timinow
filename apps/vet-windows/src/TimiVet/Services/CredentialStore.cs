using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TimiVet.Services;

/// <summary>
/// Everything needed to resume a Clerk session without re-prompting for identifier/password/code.
/// The Clerk "client" cookie (__client) is the long-lived credential; the Worker token is short-lived
/// and re-minted from it. None of this is a password or a long-lived Worker bearer token.
/// </summary>
public sealed class StoredCredential
{
    public string FrontendApiBase { get; set; } = "";
    public string ClientCookie { get; set; } = "";
    public string? ActiveSessionId { get; set; }
    public string? WorkerToken { get; set; }
    public DateTimeOffset? WorkerTokenExpiresAt { get; set; }

    /// <summary>
    /// A raw bearer token migrated from the old plaintext settings.json, kept only so nothing is
    /// silently deleted. It is never read back for authentication — a real Clerk sign-in is required.
    /// </summary>
    public string? MigratedLegacyBearerToken { get; set; }
}

/// <summary>
/// Encrypts Clerk credential state with Windows DPAPI (current-user scope) instead of writing it to
/// settings.json in plaintext. The file only decrypts under the Windows account that wrote it.
/// </summary>
public sealed class CredentialStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("TimiVet.CredentialStore.v1");
    private readonly string _directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClearKey", "TimiVet");
    private string FilePath => Path.Combine(_directory, "credentials.dat");

    public StoredCredential? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var protectedBytes = File.ReadAllBytes(FilePath);
            var plainBytes = ProtectedData.Unprotect(protectedBytes, Entropy, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<StoredCredential>(plainBytes, Json);
        }
        catch
        {
            return null;
        }
    }

    public void Save(StoredCredential credential)
    {
        Directory.CreateDirectory(_directory);
        var plainBytes = JsonSerializer.SerializeToUtf8Bytes(credential, Json);
        var protectedBytes = ProtectedData.Protect(plainBytes, Entropy, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(FilePath, protectedBytes);
    }

    public void Clear()
    {
        try { if (File.Exists(FilePath)) File.Delete(FilePath); }
        catch { /* best effort */ }
    }

    /// <summary>Used once, at first-run migration, to archive a legacy bearer token found in settings.json.</summary>
    public void SaveMigratedLegacyToken(string legacyBearerToken)
    {
        var existing = Load() ?? new StoredCredential();
        existing.MigratedLegacyBearerToken = legacyBearerToken;
        Save(existing);
    }
}
