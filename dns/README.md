# DNS for timinow.pet

```bash
./scripts/check-dns.sh
```

Run that after any change. It verifies the one thing a zone file cannot express.

## Import

Cloudflare dashboard → **timinow.pet** → **DNS** → **Records** → **Import and
Export** → **Import DNS records** → upload `timinow.pet.zone`.

## Then do the part the file cannot do

**Cloudflare imports every record as DNS-only (grey cloud).** Proxy status is
not part of the zone-file format, so it has to be set by hand afterwards — and
getting it wrong fails quietly in both directions.

| Records | Setting | What happens if it's wrong |
| --- | --- | --- |
| `@`, `www`, `app`, `providers`, `admin`, `voice` | **Proxied** (orange) | Grey-clouded, the hostname resolves to `100::` and nothing answers |
| `clerk`, `accounts`, `clkmail`, `clk._domainkey`, `clk2._domainkey` | **DNS-only** (grey) | Orange-clouded, Clerk's Frontend API breaks and sign-in fails |

`100::` is the IPv6 discard prefix. Those six records exist only so Cloudflare
has something to attach a Worker route to; no packet ever reaches that address.
Seeing `100::` come back from a lookup is the signature of a record that was
imported but never proxied — which is exactly what `check-dns.sh` looks for.

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

1. A proxied placeholder record here.
2. A `routes` entry in the Worker's `wrangler.*.jsonc`.
3. The origin in `AUTHORIZED_PARTIES`, or the Worker rejects its own front end.

`npm run check` fails if 2 and 3 disagree.
