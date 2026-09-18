/**
 * Add the records that only a dashboard can hand you the values for.
 *
 *   node scripts/dns-records.mjs --google=<token> --bing=<token> \
 *        --dkim-name=mlsend2._domainkey --dkim-value="k=rsa; p=MIGf…"
 *
 * Three records, three vendors, one thing in common: the value is generated
 * on their side and cannot be derived here. Google's Search Console token,
 * Bing's Webmaster token and MailerSend's DKIM public key are each issued to
 * an authenticated account, so this script is the half of the job that can
 * be automated — finding the zone, writing the right record with the right
 * type at the right name, not clobbering anything next to it, and checking
 * afterwards that the internet agrees.
 *
 * Pass only the flags you have. Each one is independent; nothing else in the
 * zone is read, written, or looked at.
 *
 * ── Why this exists rather than "just use the dashboard" ─────────────────
 *
 * Every one of these is a record that fails silently when it is subtly
 * wrong. A DKIM key pasted with a line break in it, a Google token put at
 * the wrong name, a Bing CNAME created proxied so Cloudflare answers instead
 * of Bing — none of them error. They simply never verify, and a fortnight
 * later somebody concludes the vendor is broken. So this validates the shape
 * before it writes, writes it the one correct way, and then resolves it
 * back through a public resolver to prove it took.
 *
 * ── Credentials ──────────────────────────────────────────────────────────
 *
 * CLOUDFLARE_API_TOKEN, with Zone → DNS → Edit on this zone. That is a
 * different permission from the one `wrangler deploy` needs, so the deploy
 * token may well be rejected here; the error says so rather than leaving you
 * guessing. The token is never printed, never logged, and never written to
 * a file.
 */

const API = "https://api.cloudflare.com/client/v4";
const DOH = "https://cloudflare-dns.com/dns-query";

/* ────────────────────────────────────────────────────────────── arguments ── */

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)(?:=([\s\S]*))?$/);
    if (!match) fail(`unrecognised argument: ${arg}`);
    out[match[1]] = match[2] === undefined ? true : match[2];
  }
  return out;
}

function fail(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const zoneName = String(args.zone || "timinow.pet");
const dryRun = Boolean(args["dry-run"]);

if (args.help) {
  console.log(`
Add search-engine verification and DKIM records to ${zoneName}.

  --google=<token>        Search Console's DNS token. This is NOT the same
                          string as the meta-tag token in wrangler.jsonc —
                          Google issues a different one per method, and
                          swapping them verifies nothing while looking right.
                          Written as: TXT @  "google-site-verification=<token>"

  --bing=<token>          Bing Webmaster's DNS token.
                          Written as: CNAME <token>.${zoneName} -> verify.bing.com
  --bing-target=<host>    Override the target if Bing prints a different one.

  --dkim-name=<name>      MailerSend's DKIM selector, exactly as its dashboard
                          shows it — e.g. mlsend2._domainkey
  --dkim-value=<value>    The record's value. A value containing '=' or ';' is
                          written as TXT (a public key); a bare hostname is
                          written as CNAME. MailerSend hands out both shapes
                          depending on the account.

  --zone=<name>           Default ${zoneName}
  --dry-run               Print the plan and change nothing.

Needs CLOUDFLARE_API_TOKEN with Zone -> DNS -> Edit.
`);
  process.exit(0);
}

/* ───────────────────────────────────────────────────── what we were given ── */

/**
 * Shape checks, before anything is sent.
 *
 * The failure mode being prevented is a paste accident: the whole HTML meta
 * tag, a quoted value, a key with the newlines the dashboard wrapped it at.
 * All three are accepted by the API and none of them verify.
 */
const plan = [];

if (typeof args.google === "string") {
  const token = args.google.trim().replace(/^google-site-verification=/, "");
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) {
    fail(`--google does not look like a Search Console token: ${JSON.stringify(token.slice(0, 40))}\n` +
         `Expected 20+ characters of letters, digits, - and _ — the value after "google-site-verification=".`);
  }
  plan.push({
    label: "Google Search Console",
    type: "TXT",
    name: zoneName,
    content: `google-site-verification=${token}`,
    proxied: false,
    // The apex already carries SPF, and a zone may hold several verification
    // TXTs. Match on this prefix so we replace our own record and leave every
    // other TXT at the same name alone.
    matchPrefix: "google-site-verification=",
    expect: (value) => value === `google-site-verification=${token}`
  });
}

if (typeof args.bing === "string") {
  const token = args.bing.trim();
  if (!/^[A-Za-z0-9]{16,64}$/.test(token)) {
    fail(`--bing does not look like a Bing Webmaster token: ${JSON.stringify(token.slice(0, 40))}`);
  }
  const target = String(args["bing-target"] || "verify.bing.com").trim().replace(/\.$/, "");
  plan.push({
    label: "Bing Webmaster",
    type: "CNAME",
    name: `${token}.${zoneName}`,
    content: target,
    // DNS-only, deliberately. Proxied, Cloudflare answers the name with its
    // own addresses and Bing never sees the CNAME it is looking for.
    proxied: false,
    expect: (value) => value.replace(/\.$/, "") === target
  });
}

if (typeof args["dkim-name"] === "string" || typeof args["dkim-value"] === "string") {
  const name = String(args["dkim-name"] || "").trim().replace(/\.$/, "");
  // Dashboards wrap long keys. A newline or run of spaces inside a TXT value
  // is the single most common reason a DKIM record exists and does not work.
  const value = String(args["dkim-value"] || "").trim().replace(/\s*[\r\n]+\s*/g, "");
  if (!name || !value) fail("--dkim-name and --dkim-value must be given together.");
  if (!/_domainkey/.test(name)) {
    fail(`--dkim-name should contain _domainkey (MailerSend shows it in full, e.g. mlsend2._domainkey): ${JSON.stringify(name)}`);
  }
  const isText = /[=;]/.test(value);
  const fqdn = name.endsWith(zoneName) ? name : `${name}.${zoneName}`;
  if (isText && !/^(v=DKIM1|k=rsa|p=)/i.test(value)) {
    fail("--dkim-value looks like neither a DKIM key nor a hostname. MailerSend's value starts with v=DKIM1, k=rsa or p=.");
  }
  plan.push({
    label: "MailerSend DKIM",
    type: isText ? "TXT" : "CNAME",
    name: fqdn,
    content: value,
    proxied: false,
    expect: (resolved) => resolved.replace(/\s+/g, "").replace(/\.$/, "") === value.replace(/\s+/g, "").replace(/\.$/, "")
  });
}

if (!plan.length) {
  fail("Nothing to do. Pass --google, --bing and/or --dkim-name/--dkim-value, or --help.");
}

/* ──────────────────────────────────────────────────────────── Cloudflare ── */

const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
if (!token && !dryRun) {
  fail("CLOUDFLARE_API_TOKEN is not set. It needs Zone -> DNS -> Edit on this zone,\n" +
       "which is a broader permission than the one `wrangler deploy` uses.\n" +
       "Re-run with --dry-run to see the plan without it.");
}

async function cf(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!body.success) {
    // Cloudflare's errors are specific and worth showing verbatim — 10000 is
    // "wrong permissions", not "wrong token", and the difference matters.
    const detail = (body.errors || []).map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new Error(detail || `HTTP ${response.status}`);
  }
  return body.result;
}

async function resolve(name, type) {
  const response = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" }
  });
  const body = await response.json().catch(() => ({}));
  return (body.Answer || [])
    .filter((answer) => answer.type === (type === "TXT" ? 16 : 5))
    .map((answer) => String(answer.data).replace(/^"|"$/g, "").replace(/" "/g, ""));
}

/* ─────────────────────────────────────────────────────────────────── run ── */

console.log(`\nZone: ${zoneName}${dryRun ? "  (dry run — nothing will be written)" : ""}\n`);
for (const record of plan) {
  // A DKIM key is long and the point of printing it is to let somebody see
  // that it is the one they copied, which the first and last characters do.
  const shown = record.content.length > 72
    ? `${record.content.slice(0, 48)}…${record.content.slice(-12)}`
    : record.content;
  console.log(`  ${record.label}`);
  console.log(`    ${record.type.padEnd(5)} ${record.name}`);
  console.log(`          ${shown}`);
  console.log(`          DNS-only (grey cloud)\n`);
}

if (dryRun) process.exit(0);

let zoneId = String(process.env.CLOUDFLARE_ZONE_ID || "").trim();
if (!zoneId) {
  const zones = await cf(`/zones?name=${encodeURIComponent(zoneName)}`).catch((error) => {
    fail(`Could not list zones: ${error.message}\nThe token needs Zone -> Zone -> Read as well as Zone -> DNS -> Edit.`);
  });
  if (!zones.length) fail(`No zone named ${zoneName} on this account.`);
  zoneId = zones[0].id;
}

let changed = 0;
for (const record of plan) {
  const existing = await cf(`/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`)
    .catch((error) => fail(`Could not read existing records: ${error.message}`));
  // For the apex TXT there may be several; ours is the one with our prefix.
  const mine = record.matchPrefix
    ? existing.find((candidate) => String(candidate.content).startsWith(record.matchPrefix))
    : existing[0];

  const payload = { type: record.type, name: record.name, content: record.content, ttl: 300, proxied: record.proxied };

  if (mine && mine.content === record.content) {
    console.log(`\x1b[32m  unchanged\x1b[0m  ${record.label} — already correct`);
    continue;
  }
  if (mine) {
    await cf(`/zones/${zoneId}/dns_records/${mine.id}`, { method: "PATCH", body: JSON.stringify(payload) })
      .catch((error) => fail(`Could not update ${record.label}: ${error.message}`));
    console.log(`\x1b[33m  updated\x1b[0m    ${record.label}`);
  } else {
    await cf(`/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(payload) })
      .catch((error) => fail(`Could not create ${record.label}: ${error.message}`));
    console.log(`\x1b[32m  created\x1b[0m    ${record.label}`);
  }
  changed += 1;
}

/* ───────────────────────────────────────────────────────────────── verify ── */

// Writing the record is not the same as the record resolving. Cloudflare is
// fast but not instant, and a mistyped name creates a perfectly valid record
// that nothing will ever ask for.
if (changed) await new Promise((resolve) => setTimeout(resolve, 3000));

console.log("");
let unresolved = 0;
for (const record of plan) {
  const answers = await resolve(record.name, record.type).catch(() => []);
  if (answers.some(record.expect)) {
    console.log(`\x1b[32m  resolves\x1b[0m   ${record.name}`);
  } else {
    unresolved += 1;
    console.log(`\x1b[33m  pending\x1b[0m    ${record.name} — written, not resolving yet (give it a minute, then re-run)`);
  }
}

console.log(unresolved
  ? "\nRecords are in place. Re-run to confirm once they propagate.\n"
  : "\nAll set. Verify the property in each dashboard now — the records are live.\n");
