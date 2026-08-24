# Tími Vet for Windows

Tími Vet is the veterinary-team-only native Windows operations client. It is a .NET 10 WPF application and
does not embed the customer website. It is the sibling of the macOS console in `apps/vet-desktop`; the two
talk to the same Worker, default to the same address, and are meant to be indistinguishable in use.

## Product capabilities

- **Connects by itself.** A fresh install already points at `https://providers.timinow.pet`, restores its
  Clerk session at launch, and opens straight onto the queue. Nobody at a front desk is asked for a
  Cloudflare Worker URL.
- **Accept and decline on the request itself**, in the review queue and on the floating panel, using the
  clinic's own default arrival window and wait estimate. The decision workspace is still there for
  shaping an offer — a later time, a different window, a note — and is no longer the only way to answer.
- **Honest connection state.** Live, reconnecting, offline, or sign-in required, with the reason and the
  time of the last successful update. Reconnection backs off on its own and jumps straight back in when
  Windows reports the network is up again.
- **An alert that is actually audible**, played through this app's own output rather than the Windows
  event beep, with a Test button in Settings.
- **Clinic calling preferences** (`GET`/`PATCH /api/clinic/call-preferences`): whether Tími rings the
  clinic at all, which number it rings, and quiet hours.
- **Owner-recorded medications and allergies**, labelled "reported by owner, unverified", on the request
  and in the decision workspace.
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
  email/phone one-time codes as the only sign-in methods — no password step, no OAuth buttons —
  and a workspace picker for accounts in more than one organization
- A tenant people console (roster, invite, role change, remove, revoke invitation) for workspace admins
- Complete interactive fixture mode when no HTTPS Worker URL is configured

## Install on this machine

One command builds the console and installs it the way Windows expects an
application to exist - a stable location under the current user, a Start Menu
entry, searchable, pinnable:

```powershell
powershell -ExecutionPolicy Bypass -File apps\vet-windows\install.ps1
```

Add `-Desktop` for a desktop shortcut too. It needs no administrator rights,
stops a running instance first, refuses to touch the previous install if the
build fails, and launches the result. Re-running it is the upgrade path.

This exists because `dotnet publish` alone leaves the executable five folders
deep inside `bin\`, which is not a place anyone finds an app: every round of
"is this the new build" this project has had came from launching whatever old
copy was actually reachable. The installed app's footer shows its own build
time, so a stale copy identifies itself.

## Build on Windows

Install the .NET 10 SDK or Visual Studio 2022 with **.NET desktop development**, then:

```powershell
cd apps\vet-windows
dotnet restore
dotnet build TimiVet.sln -c Release
dotnet run --project src\TimiVet\TimiVet.csproj
```

Publish a self-contained Windows x64 build — one `TimiVet.exe` a clinic can copy onto a
front-desk machine with no .NET runtime installed:

```powershell
Stop-Process -Name TimiVet -Force -ErrorAction SilentlyContinue; dotnet publish src\TimiVet\TimiVet.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
```

The `Stop-Process` is not tidiness. A single-file publish rewrites `TimiVet.exe`
in place, and Windows will not let it delete a running executable — so if the
console is open, `GenerateBundle` fails with
`System.UnauthorizedAccessException: Access to the path ... is denied`, several
frames of MSBuild stack, and no sentence anywhere saying "the app is running".
Everything before that step succeeds, including `TimiVet -> ...\TimiVet.dll`,
so the output reads like a build that worked apart from something obscure at
the end. The .exe left on disk is the previous one, which then starts normally
and behaves like the previous one — testing an old binary while believing it is
the new one.

`IncludeNativeLibrariesForSelfExtract` is not optional here, whatever the flag name suggests.
`PublishSingleFile` bundles managed assemblies only; WPF drags several native ones with it
(`PresentationNative_*.dll`, `wpfgfx_*.dll`, `D3DCompiler_47_cor3.dll`, `vcruntime140_cor3.dll`),
and without this they are written next to the executable instead of into it. The build succeeds
either way, so the failure shows up later — as an .exe somebody copied on its own and which then
will not start on the machine they copied it to.

The result is `src\TimiVet\bin\Release\net10.0-windows10.0.19041.0\win-x64\publish\TimiVet.exe`,
around 150 MB because the runtime is inside it. Add `-p:PublishReadyToRun=true` to trade a larger
file for a faster cold start, which on an old front-desk PC is usually the trade worth making.

The executable is unsigned. Windows SmartScreen will show "Windows protected your PC" on first run
until it is signed with an Authenticode certificate; **More info → Run anyway** gets past it for
testing, but a code-signing certificate is the answer before any clinic installs this.

On first launch the sign-in window opens straight onto **email or phone**: the production
Worker address is the default and its Clerk instance is resolved before the window is interactive. The
address step only appears if that address cannot be reached, and then it carries the reason rather than a
blank field; **Connect to a different Tími Worker** on the identifier screen reaches it deliberately, for a
private deployment or a loopback development Worker.

The operations console does not appear until a session with clinic workspace access is established, and
closing the sign-in window exits the app rather than falling back to a bypass. Once
signed in, **Connection, calling, alerts, and startup settings** in the main window lets you change the Worker URL,
polling interval, calling preferences, and alert preferences — there is no token field there; credentials live only in the
encrypted store described below. The interactive fixture mode (no backend required) still exists for UI
exploration, but only once already signed in and pointed at a non-HTTPS address — it is no longer a way to
skip sign-in at startup.

## Security and production notes

- **Sign-in is a real Clerk flow with entirely custom UI.** `Services/ClerkAuthService.cs` drives Clerk's
  Frontend API directly over HTTPS (`/v1/client/sign_ins`, `prepare_first_factor`, `attempt_first_factor`,
  `/v1/client`, `/v1/client/sessions/{id}/tokens/timinow`, `/v1/me/organization_memberships`, `.../touch`).
  No Clerk-hosted or Clerk-branded surface is ever mounted — every screen in `Views/SignInWindow.xaml` is
  Tími-designed WPF. **One-time codes are the only first factors offered**: an emailed code or a texted
  code. The password step (and its `PasswordBox`), the password-reset path, and the Google/Apple OAuth
  browser round trip were all removed on the owner's instruction that every sign-in surface offers email
  and phone codes only; any other strategy Clerk reports for an account is filtered out of the picker.
- **Clerk is talked to as a native client, not as a browser.** Every Frontend API request carries
  `_is_native=true` and the Clerk client JWT in the `Authorization` header; cookies are off in that mode,
  and the two are never mixed (Clerk refuses a request carrying both, which is why there are two
  `HttpClient`s). The client JWT is read from every response *before* the status is checked, because Clerk
  issues it on failures too and ordinary steps of this flow run straight through one. If the instance has
  the Native API switched off it answers `native_api_disabled`, and this falls back to the cookie path
  once and stays there for the launch.
- **There is no bearer-token field anywhere in the app.** `AppSettings` no longer has a `BearerToken`
  property, and `Views/MainWindow.xaml` no longer has the `PasswordBox` that used to write one.
- **A network blip at launch is not a sign-out.** `ClerkAuthService.RestoreAsync` erases the stored
  credential only when Clerk actively refuses it (401, 403, 404). A timeout, a DNS failure or a 5xx says
  nothing about the account, so the console resumes on the credential it already has and reconnects in the
  background. If `/api/session` cannot be reached either, and this machine's credential has previously
  passed the clinic-surface check within the last 30 days, the console opens anyway and reports itself as
  OFFLINE rather than demanding a sign-in nobody can complete without a network. A credential that has
  never passed that check still goes to the sign-in window.
- **`/api/config` is reachable without a session.** It is where the Clerk publishable key comes from, so
  requiring a token to fetch it would be a deadlock: no config, no Clerk host, no sign-in, no session, no
  config. `ClinicApiClient` exempts exactly that path, and the sign-in flow routes through the same gated
  client rather than keeping a private `HttpClient` that hides the problem.
- **Tokens never touch settings.json.** `Services/CredentialStore.cs` encrypts the Clerk client JWT (and,
  for blobs written before native mode, the `__client` cookie),
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
- **The palette is pinned light.** WPF's stock control templates resolve their colours through
  `SystemColors`, which follow Windows; this console's palette is painted by hand and light, and the macOS
  console was unreadable in dark mode for exactly that reason. `Theme/Theme.xaml` overrides the
  `SystemColors` brush keys and sets an explicit background and foreground on every control style, so
  nothing here asks the operating system what colour anything should be. .NET's `ThemeMode` property is
  deliberately not used: it is experimental and also swaps every control to the Fluent templates, which is
  a wholesale restyling rather than a colour pin.
- The application never makes clinical decisions and always labels customer-selected offers as operational availability rather than an appointment or triage priority.

### Clerk dashboard configuration required

- A JWT template named **`timinow`** (see `docs/PLATFORM-CONTRACT.md`) so the Worker can authorize without
  an extra Backend API round trip.
- The OAuth redirect-URL entry this section used to require
  (`http://127.0.0.1/timivet-callback/` plus the ephemeral loopback port range) is **no longer required**:
  Google/Apple OAuth was removed from the sign-in flow, so nothing in this app ever opens a browser
  redirect or listens on loopback. The entry can be deleted from the Clerk instance once no older build of
  this console is still in use.

### Sign-in methods

Email and phone one-time codes are the only sign-in methods this console offers, matching every other Tími
sign-in surface. Passwords, Google/Apple OAuth, and passkeys are not offered — an account whose only Clerk
factor is one of those must have an email address or phone number added by a workspace administrator before
it can sign in here. (Passkeys additionally would need the Windows `webauthn.dll` FIDO2 interop that was
never built for this app; that constraint is moot now that codes are the whole surface.)
