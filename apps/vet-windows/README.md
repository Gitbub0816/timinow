# Tími Vet for Windows

Tími Vet is the veterinary-team-only native Windows operations client. It is a .NET 8 WPF application and does not embed the customer website.

## Product capabilities

- Full live-intake operations dashboard
- Clinic capacity publishing with freshness/expiry controls
- Automatic queue polling with request deduplication
- Native Windows tray alerts and optional alert sound
- Professional review workspace with owner, pet, urgency, red flags, travel, and concern detail
- Availability offer type, timing, arrival window, wait estimate, hold period, and clinic instructions
- Decline workflow
- Draggable, resizable floating queue that defaults to `Topmost=true`
- Minimize, hide-to-tray, restore, and start-with-Windows controls
- Clerk bearer-token-ready production mode and header-based demo tenant mode
- Complete interactive fixture mode when no HTTPS Worker URL is configured

## Build on Windows

Install the .NET 8 SDK or Visual Studio 2022 with **.NET desktop development**, then:

```powershell
cd apps\vet-windows
dotnet restore
dotnet build TimiVet.sln -c Release
dotnet run --project src\TimiVet\TimiVet.csproj
```

Publish a self-contained Windows x64 build:

```powershell
dotnet publish src\TimiVet\TimiVet.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

The app begins in fixture mode. Expand **Connection, alerts, and startup settings** to enter the production Cloudflare Worker URL and tenant/auth configuration.

## Security and production notes

- Do not distribute long-lived Clerk tokens manually. Replace the token field with Clerk's supported desktop OAuth flow before enabling required authentication in production.
- Tokens are currently persisted in the local settings file for development convenience. Production builds must store refreshed credentials in Windows Credential Manager.
- The application never makes clinical decisions and always labels customer-selected offers as operational availability rather than an appointment or triage priority.
