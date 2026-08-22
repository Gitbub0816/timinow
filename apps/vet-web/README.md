# Tími Vet — veterinary operations console

A web port of the WPF desktop app in `apps/vet-windows`, deployed as its own
Cloudflare Worker (`timinow-vet`) so a clinic staffer never shares an origin
with the public customer app or the platform admin console. See
`docs/PLATFORM-CONTRACT.md` for the full authorization model and the shared
`/api/*` surface every Tími Worker serves identically.

## What it is

A single-page app (`public/index.html` + `public/app.js`) behind a thin
Worker router (`src/index.js`). The Worker does not duplicate business logic:
the four `/api/clinic/*` handlers (`clinicDashboard`, `setClinicAvailability`,
`decideIntake`, `respondToCareSearch`) are imported straight from
`../../../src/index.js`, and Clerk verification, session description, and
tenant member administration come from the shared `src/auth.js`,
`src/session.js`, `src/db.js`, and `src/tenant-admin.js` modules the same way.

## How it maps to the Windows app

| Windows (WPF) | Web (this app) |
| --- | --- |
| `Views/MainWindow.xaml` | `#console` screen — dark left rail, capacity card, metrics, review queue, decision workspace, settings expander |
| `Views/MiniWindow.xaml`, `Topmost="True"` | The floating console, opened with the Document Picture-in-Picture API (see below) |
| `ViewModels/MainViewModel.cs` — 6-second poll, `_knownPending` diffing | `app.js` `refreshDashboard()` on a `setInterval`, diffing `state.knownPendingIds`, skipping alerts on the first load |
| `Services/ClinicApiClient.cs` | `app.js` `api()` — same endpoints, same request/response shapes, Clerk bearer token instead of a stored bearer/tenant setting |
| `Services/AlertService.cs` (tray balloon, sound) | `Notification` API + a short WebAudio beep, same title/body truncation rule |
| `Theme/Theme.xaml` | `public/styles.css` — the same design tokens, extended with the WPF-only ones (canvas, capacity card, disclaimer banner, rail text colors, mode card) |
| `Services/SettingsStore.cs` (`%LocalAppData%\ClearKey\TimiVet\settings.json`) | `localStorage["timi_vet_settings_v1"]` |

Clinic access follows a signed-in Clerk organization exactly like the desktop
app's bearer token + tenant ID, just resolved through Clerk sessions instead
of a settings file. Sign-in, the organization picker, and the people roster
are all custom UI — no prebuilt Clerk component (`mountSignIn`,
`mountOrganizationSwitcher`, etc.) is used anywhere in `app.js`, per the
platform-wide authentication rule.

## The always-on-top floating console

`openMiniWindow()` in `app.js` tries the **Document Picture-in-Picture API**
(`window.documentPictureInPicture.requestWindow({ width: 390, height: 300 })`)
first. That window is genuinely always-on-top and chrome-less — the closest
web equivalent to WPF's `Topmost="True"` — and this app builds its DOM
directly (no extra script injection needed: the PiP document is same-origin
and synchronously scriptable from the main page). The whole stylesheet is
cloned into it (`cloneStylesInto()` re-creates every `<style>` from
`document.styleSheets` and clones any `<link rel="stylesheet">`), so the mini
window renders with the exact same tokens and mini-window classes defined in
`styles.css`.

**Browser support:** Document Picture-in-Picture currently ships in Chrome,
Edge, and other Chromium-based browsers. When `documentPictureInPicture` is
absent from `window`, the app falls back to a plain `window.open(...,
"popup=yes,width=390,height=300")` window and says so plainly in the mini
window itself ("this browser lacks Document Picture-in-Picture… Chrome or
Edge keep it always on top").

The mini window is kept live by re-rendering its DOM on every poll tick
(`renderMiniWindow()`, called from `refreshDashboard()` and `setStatus()`),
and is closed cleanly on sign-out (`closeMiniWindow()`).

**Auto-open on a new request:** when a new pending request arrives and the
"auto-open floating console" setting is on, the app tries to open the mini
window automatically. Both `documentPictureInPicture.requestWindow()` and
`window.open()` can be refused by the browser when there isn't a fresh user
gesture behind the call (a poll tick isn't one) — `openMiniWindow()` returns
`false` in that case instead of throwing, and the app falls back to a
`Notification` plus a dismissable in-page banner with a one-click "Open
floating console" button, which *is* a user gesture and succeeds.

Every new pending request also fires a `Notification` (title `Emergency
intake · {pet}` or `New intake · {pet}`, body the truncated concern summary)
and, if enabled, a short WebAudio beep — mirroring `AlertService.cs`.

## Deploy

```
npx wrangler deploy --config wrangler.vet.jsonc
```

Required secret:

```
wrangler secret put CLERK_SECRET_KEY --config wrangler.vet.jsonc
```

`CLERK_SECRET_KEY` is the Clerk Backend API secret key. It is used to verify
session tokens against the JWKS, look up users by email when adding a member,
seat/re-role/remove workspace members, and merge Clerk metadata during the
`/api/session` repair pass (see `src/session.js`).
