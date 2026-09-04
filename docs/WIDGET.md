# Clinic availability widget

A small status card a clinic embeds on its own public website:

```html
<script src="https://timinow.pet/widget.js" data-timi-widget="YOUR_TOKEN"></script>
```

It shows pet owners whether the clinic is currently accepting urgent
patients, and — if not — links them into Tími to find another available
veterinary team nearby, instead of a phone that rings unanswered or a page
that says nothing.

## What the widget can access

Exactly one thing: the coarse public status of one clinic location, through
one public API call, using one token as its credential. Nothing more.

The response is built from an explicit **whitelist** — the code that
assembles it is only ever handed two fields, so there is no field left to
accidentally include:

| Field | What it is |
| --- | --- |
| `status` | One of `accepting`, `diverting`, `full`, or `unavailable` |
| `freshness` | A coarse phrase like "Updated 6 minutes ago" |
| `link` | A link into Tími's own search, carrying attribution so Tími can see the widget is working |
| `generatedAt` | When this response was produced |

## What the widget can never access

- The clinic's **name or address** — the response never names the clinic at
  all, since the token is issued to one and only one clinic and the clinic's
  own page is the one showing it.
- **Exact capacity numbers** — wait times, patient counts, staffing.
- **Any customer data** — no pet owner's name, phone, pet, or concern is ever
  reachable through a widget token.
- **Any financial data** — deposits, payouts, ledger entries.
- **Tími's site admin console.** A widget token is not a login. It cannot
  view, and has never seen, the clinic dashboard, the review queue, people
  management, or any other authenticated screen.
- **Any practice-management system.** The widget has no connection to,
  and no credentials for, a clinic's PMS or any other internal system —
  it only ever reads Tími's own record of the clinic's public status.
- **Tími credentials of any kind.** A widget token cannot sign in as
  anyone, cannot create or revoke other tokens, and cannot be exchanged
  for a session.

## Freshness and staleness

If a clinic's last status report has expired (nothing is currently
published, or it aged out), the widget renders **"Status unavailable,"**
never a stale "accepting." A pet owner should never be told a clinic is open
on the strength of a report the clinic itself has stopped standing behind.

## Security model

- **Random, hashed-at-rest tokens.** Each token is 192 bits of randomness.
  Tími stores only its SHA-256 hash — the plaintext is shown exactly once,
  at creation, and cannot be recovered afterward. Losing it means revoking it
  and creating a new one.
- **Scoped to one clinic, one purpose.** A token can only ever be exchanged
  for the whitelist above, for the one location it was issued to.
- **Revocable, instantly.** A clinic administrator can revoke a token from
  the console at any time; a revoked token answers exactly like one that
  never existed, so nothing about a leaked token's history leaks either.
- **Optional site allowlist.** A clinic may list the `https://` origins the
  widget is expected to run on. Requests are checked against the browser's
  own `Origin`/`Referer` headers when configured. This is deliberately
  documented as **best-effort**: those headers are sent by browsers, not by a
  direct server-side request, so this check stops a copy-pasted embed from
  quietly working on a site the clinic never listed — it is not, and is not
  meant to be, the widget's only defense. That is exactly why the response
  never contains anything more sensitive than the whitelist above.
- **HTTPS only**, throughout — the token is never accepted over plain HTTP,
  and every link the widget renders is `https://`.
- **Rate limited.** Repeated requests from one place are throttled; abuse is
  logged.
- **Audited.** Token creation, revocation, an origin mismatch, and a
  rate-limit trip are all recorded so a clinic administrator (and Tími) can
  see who created a widget and whether it has been misused.
- **No HTML injection.** The embed script builds every element with
  `document.createElement` and sets text with `textContent` — never
  `innerHTML` — so nothing the status response contains can ever be
  interpreted as markup or script, even in the event the response were
  somehow compromised.

## Managing tokens

From the clinic console's Overflow tools panel, an administrator can create
a token (optionally naming it and listing the sites it should run on),
copy the embed snippet, and revoke a token that is no longer needed or may
have leaked. Revoking one token never affects any other.
