#!/usr/bin/env bash
#
# Verify timinow.pet resolves the way the Workers and Clerk need it to.
#
#   ./scripts/check-dns.sh
#
# The six application hostnames are Cloudflare Custom Domains, created by
# `wrangler deploy` — so if one does not resolve, the Worker has not been
# deployed rather than the DNS being wrong. The Clerk hostnames are ordinary
# records that must stay DNS-only; proxying one breaks sign-in quietly.

if [ -z "${BASH_VERSION:-}" ]; then
  echo "Run with bash: bash scripts/check-dns.sh" >&2
  exit 1
fi

set -uo pipefail

DOMAIN="${1:-timinow.pet}"
FAILURES=0

green() { printf '  \033[32mok\033[0m      %s\n' "$*"; }
red()   { printf '  \033[31mFAIL\033[0m    %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
warn()  { printf '  \033[33m??\033[0m      %s\n' "$*"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# dig ships with macOS; nslookup is the fallback for a stripped-down Linux box;
# DNS-over-HTTPS through node is the fallback for a container that has neither,
# which is most of them — and this script is worth being able to run in CI.
if command -v dig >/dev/null 2>&1; then
  lookup() { dig +short "$2" "$1" @1.1.1.1 2>/dev/null; }
elif command -v nslookup >/dev/null 2>&1; then
  lookup() { nslookup -type="$2" "$1" 1.1.1.1 2>/dev/null | awk '/=/ {print $NF}'; }
elif command -v node >/dev/null 2>&1; then
  lookup() {
    node -e '
      const [name, type] = process.argv.slice(1);
      const codes = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, CAA: 257 };
      fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
            { headers: { accept: "application/dns-json" } })
        .then((response) => response.json())
        .then((body) => {
          for (const answer of body.Answer || []) {
            if (answer.type !== codes[type]) continue;
            // Match dig +short: quotes kept on TXT, trailing dot kept on CNAME.
            console.log(String(answer.data));
          }
        })
        .catch(() => {});
    ' "$1" "$2" 2>/dev/null
  }
else
  echo "Needs dig, nslookup, or node. On macOS dig is already installed." >&2
  exit 1
fi

# 100:: is the IPv6 discard prefix. An earlier version of the zone file shipped
# placeholder records pointing there; they now block Custom Domain creation and
# must be deleted.
proxied() {
  local host="$1"
  local answer
  answer="$(lookup "$host" A; lookup "$host" AAAA)"
  if [ -z "$answer" ]; then
    red "$host does not resolve — deploy its Worker: npm run deploy:all"
  elif printf '%s' "$answer" | grep -q '^100::$'; then
    red "$host resolves to 100:: — a leftover placeholder record. Delete it in the Cloudflare dashboard, then redeploy so the Custom Domain can be created."
  else
    green "$host resolves"
  fi
}

dns_only_cname() {
  local host="$1" expect="$2"
  local answer
  answer="$(lookup "$host" CNAME | head -1)"
  if [ -z "$answer" ]; then
    warn "$host has no CNAME yet — add it from the Clerk dashboard"
  elif printf '%s' "$answer" | grep -qi "$expect"; then
    green "$host -> $answer"
  else
    red "$host -> $answer (expected something matching $expect; if it points at Cloudflare, it is proxied and must be DNS-only)"
  fi
}

head2 "Application hostnames (Custom Domains, created by wrangler deploy)"
proxied "$DOMAIN"
for sub in www app providers admin voice; do proxied "$sub.$DOMAIN"; done

head2 "Clerk (must be DNS-only)"
dns_only_cname "clerk.$DOMAIN"          "clerk.services"
dns_only_cname "accounts.$DOMAIN"       "clerk.services"
dns_only_cname "clkmail.$DOMAIN"        "clerk.services"
dns_only_cname "clk._domainkey.$DOMAIN" "clerk.services"
dns_only_cname "clk2._domainkey.$DOMAIN" "clerk.services"

head2 "Mail policy"
spf="$(lookup "$DOMAIN" TXT | tr -d '"' | grep '^v=spf1' | head -1)"
[ -n "$spf" ] && green "SPF: $spf" || red "no SPF record — the domain can be spoofed"
dmarc="$(lookup "_dmarc.$DOMAIN" TXT | tr -d '"' | grep '^v=DMARC1' | head -1)"
[ -n "$dmarc" ] && green "DMARC: $dmarc" || red "no DMARC record"

head2 "DKIM"
# SPF says a host may send as this domain. DKIM signs the message, and it is
# what a large mailbox provider actually weighs — and what DMARC can align on
# when the envelope sender does not match. Missing, mail still arrives; it
# just arrives with one fewer reason to be believed.
dkim_found=0
for selector in mlsend mlsend2 mlsend3; do
  value="$(lookup "$selector._domainkey.$DOMAIN" TXT; lookup "$selector._domainkey.$DOMAIN" CNAME)"
  if [ -n "$value" ]; then green "MailerSend DKIM at $selector._domainkey"; dkim_found=1; fi
done
[ "$dkim_found" -eq 1 ] || warn "no MailerSend DKIM selector published — mail is SPF-authenticated but unsigned. MailerSend's dashboard prints the selector and value; add them with: node scripts/dns-records.mjs --dkim-name=... --dkim-value=..."
clerk_dkim="$(lookup "clk._domainkey.$DOMAIN" CNAME)"
[ -n "$clerk_dkim" ] && green "Clerk DKIM at clk._domainkey" || warn "no Clerk DKIM — sign-in codes send unsigned"

head2 "Search-engine verification"
# Neither is required for the site to work, and neither can be invented here:
# each is a token issued to an authenticated account. Absent is a warning, not
# a failure — but an unverified property is a Search Console with no data in
# it, which is the one feedback loop the SEO work cannot provide from code.
gsv="$(lookup "$DOMAIN" TXT | tr -d '"' | grep '^google-site-verification=' | head -1)"
[ -n "$gsv" ] && green "Search Console (domain property) verified by TXT" \
  || warn "no google-site-verification TXT — a URL-prefix property may still be verified by the meta tag served from src/verification.js"
# Bing's DNS method is a CNAME at <token>.<domain>, so there is no fixed name
# to probe. The meta tag and /BingSiteAuth.xml are checked against the live
# site instead, which covers whichever method was used.
if curl -fsS --max-time 10 "https://$DOMAIN/BingSiteAuth.xml" >/dev/null 2>&1; then
  green "Bing verified by /BingSiteAuth.xml"
elif curl -fsS --max-time 10 "https://$DOMAIN/" 2>/dev/null | grep -q 'msvalidate.01'; then
  green "Bing verified by meta tag"
else
  warn "Bing not verified — set BING_SITE_VERIFICATION in wrangler.jsonc and deploy, or add its CNAME with: node scripts/dns-records.mjs --bing=<token>"
fi

head2 "Certificate authority"
caa="$(lookup "$DOMAIN" CAA)"
if [ -n "$caa" ]; then
  printf '%s' "$caa" | grep -q 'letsencrypt.org' \
    && green "CAA allows letsencrypt.org (Clerk needs it)" \
    || red "CAA is set but omits letsencrypt.org — Clerk cannot issue a certificate"
else
  warn "no CAA records (permitted, but any CA may then issue for this domain)"
fi

head2 "Live endpoints"
for host in "$DOMAIN" "providers.$DOMAIN" "admin.$DOMAIN" "voice.$DOMAIN"; do
  body="$(curl -fsS --max-time 10 "https://$host/api/health" 2>/dev/null)"
  if [ -n "$body" ]; then green "$host $body"; else red "$host /api/health did not answer"; fi
done

echo
if [ "$FAILURES" -eq 0 ]; then
  printf '\033[1mDNS looks right.\033[0m\n'
else
  printf '\033[31m%s check(s) failed.\033[0m See dns/README.md.\n' "$FAILURES"
  exit 1
fi
