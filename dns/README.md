# DNS for timinow.pet

```bash
./scripts/check-dns.sh
```

Run that after any change. It verifies the one thing a zone file cannot express.

## Import

Cloudflare dashboard → **timinow.pet** → **DNS** → **Records** → **Import and
Export** → **Import DNS records** → upload `timinow.pet.zone`.

## If you imported the earlier version of this file — delete six records

An earlier revision shipped placeholder `AAAA 100::` records for `@`, `www`,
`app`, `providers`, `admin`, and `voice`. **Delete them.**

They were for Workers *Routes*. The Workers now use *Custom Domains*, where
Cloudflare creates and manages the record itself — and it refuses to create one
when a record already exists at that hostname. Leaving the placeholders in place
is why nothing answers: the name resolves to the IPv6 discard prefix and the
request hangs.

After deleting them:

```bash
npm run deploy:all
./scripts/check-dns.sh
```

## Proxy status

Only the Clerk records need a decision, and they must stay **DNS-only** (grey
cloud). Proxying `clerk` or `accounts` breaks the Frontend API and sign-in
fails.

The application hostnames are not in this file at all — `wrangler deploy`
creates them, already proxied, with a certificate.

## The three Clerk records that aren't in the file

`clkmail`, `clk._domainkey`, and `clk2._domainkey` are commented out on purpose.
Their targets contain an instance id only your Clerk dashboard knows, so
importing them with a placeholder would create three broken records.

Clerk shows the exact values under **Domains → DNS records**. Add those three by
hand — usually quicker than editing and re-importing.

They are not optional. Without them Clerk still sends one-time codes, but from a
Clerk address rather than `timinow.pet`, which is not what a veterinary practice
wants to see in an email asking them to accept a patient.

## Choices worth knowing about

**The apex publishes `v=spf1 -all`.** Nothing sends mail from `timinow.pet`
today — the app's addresses are on `clearkey.solutions`, and Clerk sends from
the `clkmail` subdomain, which Clerk's own records authenticate. On a domain
nobody sends from, a hard fail is free anti-spoofing: it stops someone forging
`billing@timinow.pet` at a clinic.

If you add a sender later, replace that line. For Google Workspace:

```
@  300  IN  TXT  "v=spf1 include:_spf.google.com -all"
```

and delete the null `MX 0 .`, replacing it with Google's MX records.

**DMARC starts at `p=none`.** Reports go to your address so you can see what is
being sent in your name. Read them for a fortnight, then tighten to
`p=quarantine`, then `p=reject`. Going straight to reject is how legitimate mail
disappears without anyone noticing.

**CAA is restrictive.** Only the listed CAs may issue for this domain.
`letsencrypt.org` is required — Clerk uses it — and `pki.goog` covers Cloudflare
Universal SSL. Removing either breaks certificate issuance, which is why
`check-dns.sh` checks for Let's Encrypt specifically.

## Adding a hostname later

Three places, or it half-works:

1. A `routes` entry with `"custom_domain": true` in the Worker's config.
2. The origin in `AUTHORIZED_PARTIES`, or the Worker rejects its own front end.

Nothing to add to this file — Cloudflare creates the record on deploy.
`npm run check` fails if 1 and 2 disagree.
