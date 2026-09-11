using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TimiVet.Services;

/// <summary>
/// Accepts the Worker's timestamps in both shapes they actually arrive in.
/// </summary>
/// <remarks>
/// D1 rows written with SQLite's <c>CURRENT_TIMESTAMP</c> serialize as
/// <c>"2026-09-11 07:48:18"</c> — space-separated, no zone designator — and
/// System.Text.Json's built-in DateTimeOffset converter accepts only ISO
/// 8601. The first real published availability row therefore killed the
/// whole dashboard poll with a JsonException at
/// <c>$.location.availability.reportedAt</c>, which surfaced as the console
/// stuck on "Offline — queue is stale" while the Worker was answering 200s
/// the entire time. (The macOS console types these fields as plain strings,
/// which is why only Windows fell over.)
///
/// SQLite's CURRENT_TIMESTAMP is UTC by definition, so a zoneless value is
/// read as UTC (<see cref="DateTimeStyles.AssumeUniversal"/>); values that
/// carry an offset or Z keep it. Registered on the API client's options, so
/// every DateTimeOffset field on every model — availability, request
/// timestamps, member join dates — is covered in one place. Nullable fields
/// are covered too: the serializer unwraps <c>DateTimeOffset?</c> onto this
/// converter after handling the null token itself.
/// </remarks>
public sealed class SqliteTimestampJsonConverter : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        // Fast path: a well-formed ISO 8601 value, straight from the reader.
        if (reader.TryGetDateTimeOffset(out var value)) return value;

        var raw = reader.GetString();
        if (DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
        {
            return parsed;
        }
        throw new JsonException($"Could not read \"{raw}\" as a timestamp.");
    }

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToUniversalTime().ToString("O"));
}
