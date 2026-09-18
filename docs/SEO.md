# Being found — search engines and answer engines

What this codebase does so that somebody looking for veterinary care at one in
the morning finds Tími, and what it deliberately does not do. Everything
described here is enforced by `scripts/seo-test.mjs`, which runs in
`npm run check`; where something is a convention rather than a check, it says
so.

## The problem this pass fixed

Three separate failures, each total in its own way.

**The blog answered every URL with an empty shell.** `blog.timinow.pet/p/x`
returned the single-page app, which then fetched the post from `/api` in the
browser. Googlebot renders JavaScript, eventually, on a second pass, if it
spends the budget. Most other crawlers render less. The crawlers that matter
most for this product — the ones behind assistants, which is increasingly how
"is this an emergency" gets asked — very largely do not run JavaScript at all.
Every post the company had written, and every answer a clinic had given in the
forum, was a loading message to them.

**The customer site was one URL.** The app routes on the hash: `#emergency`,
`#vets`, `#paw-it-forward`, `#legal`. A fragment is not a URL. Google saw one
document, with one title and one description, that was about everything — so
it could rank strongly for nothing.

**Nothing told a crawler anything.** No robots.txt on any surface, no sitemap,
no canonical, no structured data, no feed. The consoles at
`providers.timinow.pet` and `admin.timinow.pet` were as crawlable as the
marketing site.

## What exists now

### Crawlable documents, served before any JavaScript runs

| URL | What answers it |
|---|---|
| `timinow.pet/` | The app shell, with a server-rendered `<head>` (`renderHome`, `src/index.js`). The marketing copy was already real markup. |
| `timinow.pet/emergency-vet` | Standalone document (`src/landing.js`) |
| `timinow.pet/how-it-works` | Standalone document |
| `timinow.pet/help-with-vet-bills` | Standalone document |
| `timinow.pet/for-veterinarians` | Standalone document |
| `timinow.pet/pricing` | Standalone document |
| `timinow.pet/blog/` | Rendered post index (`apps/blog/src/pages.js`), forwarded to the blog Worker over a service binding |
| `timinow.pet/blog/p/:slug` | The whole post, its comments, its notices |
| `timinow.pet/blog/forum` | Rendered thread index |
| `timinow.pet/blog/t/:slug` | The thread **and its replies** |

The landing documents deliberately do not load `app.js`. A marketing page that
boots a single-page application in order to show a paragraph is slower,
flickers on arrival, and fights its own router over which screen is showing.

The blog pages are injected into the app shell as a `data-ssr` block, which
`apps/blog/public/app.js` removes on boot. Crawlers and assistants see the
content; browsers see it for one paint and then get the app.

### Discovery

| File | Surface | Notes |
|---|---|---|
| `/robots.txt` | customer | Allows everything, names the assistant crawlers explicitly, points at both sitemaps |
| `/robots.txt` | blog | Same, plus `Disallow: /subscribe/` (single-use tokens) |
| `/robots.txt` | vet, admin, widget-demo | `Disallow: /` — these are consoles |
| `/sitemap.xml` | customer | Static list, generated from `LANDING_PAGES` so a page cannot exist without being listed |
| `/sitemap.xml` | blog | Built from D1 per request, so posts appear between deploys |
| `/feed.xml` | blog | RSS 2.0 |
| `/llms.txt` | customer, blog | A plain-text map, plus the facts a summariser has to get right |

### Structured data

One `@graph` per page. `Organization` and `WebSite` on every surface with the
same `@id`, so four subdomains read as one company rather than four weak
entities. Then per page: `Service` and `FAQPage` on the landing documents,
`BlogPosting` and `BreadcrumbList` on a post, `DiscussionForumPosting` with
its `comment` array on a thread, `CollectionPage` + `ItemList` on the indexes.

`Service`, not `LocalBusiness`: Tími is not a place anybody visits, and
claiming an address people could drive to would be both false and the kind of
false that earns a manual action.

There is no `aggregateRating` anywhere, and there will not be one until there
are real reviews to aggregate.

## Answer-engine specifics

The assistant crawlers are **allowed on purpose** — `GPTBot`, `OAI-SearchBot`,
`ClaudeBot`, `PerplexityBot`, `Google-Extended`, `Applebot-Extended` and the
rest are named in robots.txt even though each is opt-out and would be
permitted by silence. Somebody will eventually propose blocking them to
"protect the content". The content is a directory of which veterinary
hospitals can see a patient tonight; being quoted by an assistant at 1am is
the product working.

Three things follow from writing for a reader that quotes a page without
showing it:

- `max-snippet:-1` on every indexable page, so there is no cap on how much may
  be quoted.
- Every FAQ answer is a complete sentence that stands alone. The test asserts
  each is over 60 characters and that the visible page contains the same
  question, because FAQ structured data that does not match the page is the
  textbook manual action.
- `llms.txt` carries a short block of facts a summariser must get right —
  what Tími is not, that availability is not an appointment, that the fee is
  not a veterinary charge, that the fund does not pay vet bills, and that
  coverage is not nationwide.

## The rules that make this safe

The crawlable surface publishes words typed by clinics and by the public. It
is an injection surface, and it is also the most quotable copy the company
has, which makes it a safety surface.

- **Escaping.** Everything interpolated is HTML-escaped; JSON-LD is serialised
  with `<`, `>` and `&` as `\u` escapes so it cannot close its own `<script>`
  or open an HTML comment. There is a test that renders a post titled
  `</title><script>alert(1)</script>` and asserts the only scripts on the page
  are the shell's and the JSON-LD.
- **No cloaking.** The server-rendered copy is the same copy, not a teaser.
- **The notices travel with the words.** The "not veterinary advice" strip and
  a clinic's non-endorsement are inside the rendered body, not added by
  script, because they are the sentences most likely to be quoted out of
  context.
- **Soft 404s are real 404s.** An unknown slug answers 404 with `noindex`.
- **Claims are checked.** `scripts/seo-test.mjs` fails the build if a landing
  page says "nationwide", mentions SOC 2, uses any of the marketing words
  CLAUDE.md rule 8 bans, or quotes a price that disagrees with
  `src/pricing.js`.
- **Shell markers are asserted.** `renderIntoShell` does string surgery on
  known markers in the HTML files. The test asserts each marker still exists,
  so reformatting a shell fails the build instead of quietly shipping pages
  with no titles.

## What is not done, and why

- **City pages exist but none are published yet, on purpose.**
  `/emergency-vet/:market` renders from `src/markets.js` for any market with
  at least `MIN_CLINICS_FOR_A_MARKET_PAGE` (3) active clinics that is not
  marked inactive. Below that it is a 404 and stays out of the sitemap. At the
  network's current size that produces zero pages, which is the correct
  output: generated pages about cities with nothing behind them are thin
  content, and worse than any ranking consequence, they send somebody driving
  toward a search that comes back empty. They appear as markets fill, with no
  further work.

  They deliberately do not name clinics. Which practice can take a patient
  changes by the hour, and a published directory is wrong by the time it is
  read — the failure happening in a parking lot rather than on the page.

- **No clinic profile pages.** Same reasoning, plus a supply-side one: pages
  that rank for a practice's own name compete with that practice's website,
  and these are the partners the network depends on.
- **Search Console and Bing Webmaster are not verified yet** — waiting on two
  tokens, and on nothing else. The serving side is built: see the DNS section
  below. Once verified, submit `timinow.pet/sitemap.xml` and
  `timinow.pet/blog/sitemap.xml` and watch Coverage; that is the feedback loop
  this pass cannot provide from code.
- **No backlinks.** Nothing in a repository creates them. The realistic
  sources here are veterinary associations, local press, and the clinics
  themselves — every participating clinic that embeds the widget or links its
  own "book with us" page is a relevant link from a veterinary domain.
- **One domain, not two.** The blog moved from `blog.timinow.pet` to
  `timinow.pet/blog`. Subdomains are separate sites to a search engine:
  everything a post earned accrued to the subdomain and reached the main site
  only weakly, and the main site's standing did not help a new post rank.
  `timinow.pet` is bound as a *custom domain*, which captures the whole
  hostname, so no route can hand `/blog` to another Worker — the customer
  Worker forwards it over a service binding instead, stripping the prefix and
  telling the blog Worker where it is mounted so the links it writes point
  back to the same place. The old host still answers and will redirect.

- **`/#legal` is still a fragment.** The legal centre is eight articles under
  one hash route. They are each worth a URL and none of them is worth ranking
  for, so this stayed where it was.
- **No hreflang, no translations.** One language, one country.
- **Core Web Vitals are untested here.** The landing documents ship no
  JavaScript and one stylesheet, which is the shape that passes, but nothing
  in `npm run check` measures it. Lighthouse against production is the check
  and it needs a browser this environment does not have.

## DNS, and why verification does not need any

`timinow.pet` is on Cloudflare. Its zone currently holds, and this is the
whole of it:

| Name | Type | Value | What it is for |
| --- | --- | --- | --- |
| `timinow.pet`, `www`, `app`, `blog`, `providers`, `admin`, `voice` | A | Cloudflare proxy addresses | Not hand-written records. Every one is a **Worker Custom Domain**, created and renewed by `wrangler deploy`, certificate included. A hostname that stops resolving means a Worker was not deployed — it is not a DNS problem, and editing it by hand in the dashboard is how you break it. `scripts/check-dns.sh` checks this. |
| `clerk`, `accounts` (and Clerk's other CNAMEs) | CNAME | `*.clerk.services` | Sign-in, on every surface. **These must stay DNS-only — grey cloud, not orange.** Proxying one breaks authentication quietly: the browser gets a Cloudflare certificate for a host Clerk expects to terminate itself, and the failure looks like an SDK bug rather than a DNS change. |
| `timinow.pet` | TXT | `v=spf1 include:_spf.mailersend.net ~all` | Authorises MailerSend to send as this domain. Subscription confirmations and every transactional email go through it. |
| `_dmarc.timinow.pet` | TXT | `v=DMARC1; p=none; rua=…; ruf=…; fo=1; adkim=r; aspf=r; pct=100` | Reporting only. `p=none` asks receivers to report failures and enforce nothing — the right setting while sending volume is still low and alignment is unproven. Tighten to `p=quarantine` once the reports are clean for a few weeks. |
| `timinow.pet` | MX | `0 .` | A **null MX** (RFC 7505): this domain accepts no inbound mail, stated explicitly rather than left ambiguous. It is a deliberate anti-spam posture, not an oversight — but note that `blog@timinow.pet` in the footer is therefore send-only, and a reply to it bounces. |

Two records that are **not** there and arguably should be:

- **DKIM.** No selector is published (`mlsend._domainkey` and
  `mlsend2._domainkey` both resolve to nothing). Mail is SPF-authenticated
  but not signed, which costs deliverability with every large mailbox
  provider and leaves DMARC aligned on SPF alone. MailerSend prints the exact
  selector and public key in its dashboard under the domain's settings — they
  cannot be derived from here, because the key pair is generated on their
  side. This is the same blocker as verifying `blog@timinow.pet` as a sender.
- **A `p=quarantine` DMARC policy**, once the `rua` reports have been clean
  for long enough to trust. Not yet.

### Search-engine verification

Neither Google nor Bing needs a DNS record here, and this is the reason:

A **domain property** in Search Console (every subdomain, every scheme) can
only be verified by DNS TXT. A **URL-prefix property** rooted at
`https://timinow.pet` can be verified by a meta tag or a file — and since the
blog moved under `timinow.pet/blog`, a URL-prefix property at that root now
covers the entire crawlable surface. So the prefix property is enough, and it
is verified by something this repository can serve.

`src/verification.js` does exactly that, from two committed `vars` in
`wrangler.jsonc`, both blank until the properties are created:

- **`GOOGLE_SITE_VERIFICATION`** accepts either form Google offers and tells
  them apart on its own. A `google<hex>.html` filename is served at that path
  with the body Google checks; anything else is emitted as
  `<meta name="google-site-verification">` in the home page's head. It is
  never both — the two tokens are different strings, and pasting one into the
  other's slot verifies nothing while looking like it should.
- **`BING_SITE_VERIFICATION`** is one token used twice: the
  `msvalidate.01` meta tag and `/BingSiteAuth.xml`. Bing can also simply
  import a verified Search Console property, which is less work than either;
  this exists so that import is a choice rather than a dependency.

Neither token is a secret — publishing it *is* the mechanism, exactly as with
`INDEXNOW_KEY`. Paste, run `npm run check`, deploy. A malformed token (a
pasted whole meta tag, a quoted value, a URL) is refused rather than
published, because the alternative is a Search Console that stays empty for a
fortnight with nothing to attribute it to.

If a domain-wide property is wanted later — to see `providers.` and `admin.`
traffic in the same view — that is the DNS TXT route, and it is additive.

## Announcing changes

`src/indexnow.js` submits a post's URL to IndexNow the moment it is published
or corrected — Bing, Yandex, Seznam and Naver share the submission. Google
does not participate. Bing is the one that matters most here beyond its search
share, because several assistants read its index, so "indexed within minutes"
is the difference between a post being quotable tonight and next week.

The key is public by design: IndexNow authenticates by having the site serve
the same value at its root, so it proves domain control rather than being a
credential. It is a `var`, committed, and served at `/<key>.txt`.

Submission is hooked into `content-store.js` rather than a caller, because
posts are created from two consoles and a post announced from one path and not
the other is a gap nobody notices. It cannot throw and times out in three
seconds: a search engine being slow must never be why a publish fails.

## Authorship, for a YMYL subject

Veterinary content is held to a higher bar than most, and a named
veterinarian behind a page is the largest quality signal available. Migration
0033 stores author credentials, a reviewer, their credentials and the review
date; the post page renders them and the JSON-LD carries `reviewedBy`,
`lastReviewed` and `honorificSuffix`.

None of it is ever inferred. No defaults, no deriving a reviewer from an
author. A review line is a statement that a named, licensed person read a page
about a sick animal and stands behind it.

## If you are adding a page

1. Put it in `LANDING_PAGES` (`src/landing.js`) — the router, the sitemap and
   the test all read that one map, which makes "exists but is in no sitemap"
   and "in the sitemap but 404s" both impossible.
2. Add its path to `run_worker_first` in the relevant `wrangler*.jsonc`.
   Assets are served before the Worker runs, so a path missing from that list
   silently gets the app shell instead of your document. This is the same
   mechanism that once served every page with no security headers.
3. Give it a unique title under 75 characters, a unique description, at least
   four FAQ entries whose answers stand alone, and a link into the app and to
   at least one other page.
4. Run `npm run check`.
