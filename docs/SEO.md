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

- **No city or clinic landing pages.** The obvious next move is a page per
  market — "emergency vet in Hayward" — and it is genuinely the highest-value
  remaining work. It is not here because those pages are only worth having
  where there are real clinics behind them; generated at today's network size
  they would be thin pages about empty searches, which is worse than nothing
  and is what Google's helpful-content work exists to demote. Build them from
  `src/markets.js` when a market has clinics, not before.
- **No Search Console or Bing Webmaster verification.** Both need a DNS record
  or a file with a token nobody has issued yet. Once verified, submit
  `timinow.pet/sitemap.xml` and `blog.timinow.pet/sitemap.xml` and watch
  Coverage; that is the feedback loop this pass cannot provide from code.
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
