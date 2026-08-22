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
- Draggable, resizable floating queue that defaults to `Topmost=true`, remembers its position/size, and
  can auto-show itself when a new pending request arrives
- Minimize, hide-to-tray, restore, and start-with-Windows controls
- A fully custom-UI Clerk sign-in flow (no Clerk-hosted or Clerk-branded surface is ever mounted) with
  email/username/phone + password or one-time-code, and Google/Apple OAuth via the OS browser,
  and a workspace picker for accounts in more than one organization
- A tenant people console (roster, invite, role change, remove, revoke invitation) for workspace admins
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

On first launch the sign-in window asks for your Tími Worker's HTTPS URL, then walks you through Clerk
sign-in; the operations console does not appear until a session with clinic workspace access is
established, and closing the sign-in window exits the app rather than falling back to a bypass. Once
signed in, **Connection, alerts, and startup settings** in the main window lets you change the Worker URL,
polling interval, and alert preferences — there is no token field there; credentials live only in the
encrypted store described below. The interactive fixture mode (no backend required) still exists for UI
exploration, but only once already signed in and pointed at a non-HTTPS address — it is no longer a way to
skip sign-in at startup.

## Security and production notes

- **Sign-in is a real Clerk flow with entirely custom UI.** `Services/ClerkAuthService.cs` drives Clerk's
  Frontend API directly over HTTPS (`/v1/client/sign_ins`, `prepare_first_factor`, `attempt_first_factor`,
  `/v1/client`, `/v1/client/sessions/{id}/tokens/timinow`, `/v1/me/organization_memberships`, `.../touch`).
  No Clerk-hosted or Clerk-branded surface is ever mounted — every screen in `Views/SignInWindow.xaml` is
  Tími-designed WPF. OAuth (Google, Apple) sign-in opens the redirect URL Clerk returns in the
  user's **default OS browser**, never an embedded Clerk widget, and complete against a one-shot loopback
  `HttpListener` at `http://127.0.0.1:<port>/timivet-callback/`.
- **There is no bearer-token field anywhere in the app.** `AppSettings` no longer has a `BearerToken`
  property, and `Views/MainWindow.xaml` no longer has the `PasswordBox` that used to write one.
- **Tokens never touch settings.json.** `Services/CredentialStore.cs` encrypts the Clerk client cookie,
  active session id, and minted Worker token with Windows DPAPI (`ProtectedData`, current-user scope) into
  `%LocalAppData%\ClearKey\TimiVet\credentials.dat`. The Worker token is re-minted from the Clerk client
  roughly 10 seconds before it expires, and again on any 401 from the Worker (one retry, then surface the
  error). On first run after upgrading, a legacy plaintext `BearerToken` found in the old settings.json is
  moved into the encrypted store and blanked from the JSON file immediately — it is archived only, never
  read back for authentication, since a real Clerk sign-in is always required going forward.
- **Demo headers are confined to loopback.** `x-demo-role` / `x-demo-tenant-id` are only ever attached when
  there is no signed-in Clerk session **and** the configured Worker address resolves to `localhost` or a
  loopback IP. Any other address without a session is refused rather than silently sent demo headers,
  closing the production hazard where those headers used to reach a live HTTPS Worker whenever no bearer
  token happened to be set.
- The app will not show the operations console without a session whose `/api/session` response reports
  `surfaces.clinic: true`. An account with no clinic workspace sees a clear "not part of a veterinary
  workspace" screen instead of an empty console, and creating a brand-new workspace is explicitly called
  out as a Tími platform operation this app cannot perform (see `Views/PeopleWindow.xaml`).
- The application never makes clinical decisions and always labels customer-selected offers as operational availability rather than an appointment or triage priority.

### Clerk dashboard configuration required

- A JWT template named **`timinow`** (see `docs/PLATFORM-CONTRACT.md`) so the Worker can authorize without
  an extra Backend API round trip.
- **`http://127.0.0.1/timivet-callback/`** (and the ephemeral loopback port range the OS hands out for it)
  added as an allowed redirect origin/URL for OAuth — otherwise Google/Apple sign-in cannot complete back
  into the desktop app.
- Google and Apple OAuth connections enabled on the Clerk instance if those buttons are to work.

### Known limitation: passkeys

Passkeys are not offered in this desktop build, and the sign-in window says so rather than showing a button
that cannot work.

Clerk's Frontend API treats `strategy=passkey` differently from OAuth: it returns a WebAuthn challenge to be
signed by an authenticator, not a browser redirect URL. Completing it from WPF would mean P/Invoking the
Windows `webauthn.dll` FIDO2 API and marshalling the assertion back into
`attempt_first_factor` — a meaningful amount of native interop that has not been built here.

Everything else is available: email, username, or phone as the identifier, then password, an emailed code, a
texted code, Google, or Apple. Staff who prefer passkeys can use them in the Tími web console, which gets
WebAuthn from the browser for free. If desktop passkeys become a requirement, the work is contained to
`ClerkAuthService` and the identifier step of `SignInWindow`.
